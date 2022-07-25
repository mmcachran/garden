/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { resolve } from "path"
import { readFile } from "fs-extra"
import Bluebird from "bluebird"
import { flatten, set } from "lodash"
import { safeLoadAll } from "js-yaml"

import { KubernetesModule } from "./module-config"
import { KubernetesResource } from "../types"
import { KubeApi } from "../api"
import { gardenAnnotationKey } from "../../../util/string"
import { LogEntry } from "../../../logger/log-entry"
import { PluginContext } from "../../../plugin-context"
import { ConfigurationError, PluginError } from "../../../exceptions"
import { KubernetesPluginContext, KubernetesTargetResourceSpec, ServiceResourceSpec } from "../config"
import { HelmModule } from "../helm/module-config"
import { KubernetesDeployAction } from "./config"
import { DEFAULT_TASK_TIMEOUT } from "../../../constants"
import { CommonRunParams } from "../../../plugin/handlers/run/run"
import { runAndCopy } from "../run"
import { getTargetResource, getResourcePodSpec, getResourceContainer, makePodName } from "../util"
import { KubernetesRunAction } from "./run"
import { KubernetesTestAction } from "./test"

/**
 * Reads the manifests and makes sure each has a namespace set (when applicable) and adds annotations.
 * Use this when applying to the cluster, or comparing against deployed resources.
 */
export async function getManifests({
  ctx,
  api,
  log,
  action,
  defaultNamespace,
  readFromSrcDir = false,
}: {
  ctx: PluginContext
  api: KubeApi
  log: LogEntry
  action: KubernetesDeployAction
  defaultNamespace: string
  readFromSrcDir?: boolean
}): Promise<KubernetesResource[]> {
  const manifests = await readManifests(ctx, action, log, readFromSrcDir)

  return Bluebird.map(manifests, async (manifest) => {
    // Ensure a namespace is set, if not already set, and if required by the resource type
    if (!manifest.metadata?.namespace) {
      if (!manifest.metadata) {
        manifest.metadata = {}
      }

      const info = await api.getApiResourceInfo(log, manifest.apiVersion, manifest.kind)

      if (info?.namespaced) {
        manifest.metadata.namespace = defaultNamespace
      }
    }

    /**
     * Set Garden annotations.
     *
     * For namespace resources, we use the namespace's name as the annotation value, to ensure that namespace resources
     * with different names aren't considered by Garden to be the same resource.
     *
     * This is relevant e.g. in the context of a shared dev cluster, where several users might create their own
     * copies of a namespace resource (each named e.g. "${username}-some-namespace") through deploying a `kubernetes`
     * module that includes a namespace resource in its manifests.
     */
    const annotationValue =
      manifest.kind === "Namespace" ? gardenNamespaceAnnotationValue(manifest.metadata.name) : action.name
    set(manifest, ["metadata", "annotations", gardenAnnotationKey("service")], annotationValue)
    set(manifest, ["metadata", "labels", gardenAnnotationKey("service")], annotationValue)

    return manifest
  })
}

const disallowedKustomizeArgs = ["-o", "--output", "-h", "--help"]

/**
 * Read the manifests from the module config, as well as any referenced files in the config.
 *
 * @param module The kubernetes module to read manifests for.
 * @param readFromSrcDir Whether or not to read the manifests from the module build dir or from the module source dir.
 * In general we want to read from the build dir to ensure that manifests added via the `build.dependencies[].copy`
 * field will be included. However, in some cases, e.g. when getting the service status, we can't be certain that
 * the build has been staged and we therefore read the manifests from the source.
 *
 * TODO: Remove this once we're checking for kubernetes module service statuses with version hashes.
 */
export async function readManifests(
  ctx: PluginContext,
  action: KubernetesDeployAction,
  log: LogEntry,
  readFromSrcDir = false
) {
  const manifestPath = readFromSrcDir ? action.basePath() : action.getBuildPath()

  const spec = action.getSpec()

  const fileManifests = flatten(
    await Bluebird.map(spec.files, async (path) => {
      const absPath = resolve(manifestPath, path)
      log.debug(`Reading manifest for module ${action.name} from path ${absPath}`)
      const str = (await readFile(absPath)).toString()
      const resolved = ctx.resolveTemplateStrings(str, { allowPartial: true, unescape: true })
      return safeLoadAll(resolved)
    })
  )

  let kustomizeManifests: any[] = []

  if (spec.kustomize?.path) {
    const kustomize = ctx.tools["kubernetes.kustomize"]

    const extraArgs = spec.kustomize.extraArgs || []

    for (const arg of disallowedKustomizeArgs) {
      if (extraArgs.includes(arg)) {
        throw new ConfigurationError(
          `kustomize.extraArgs must not include any of ${disallowedKustomizeArgs.join(", ")}`,
          {
            spec,
            extraArgs,
          }
        )
      }
    }

    try {
      const kustomizeOutput = await kustomize.stdout({
        cwd: manifestPath,
        log,
        args: ["build", spec.kustomize.path, ...extraArgs],
      })
      kustomizeManifests = safeLoadAll(kustomizeOutput)
    } catch (error) {
      throw new PluginError(`Failed resolving kustomize manifests: ${error.message}`, {
        error,
        spec,
      })
    }
  }

  return [...spec.manifests, ...fileManifests, ...kustomizeManifests]
}

/**
 * We use this annotation value for namespace resources to avoid potential conflicts with module names (since module
 * names can't start with `garden`).
 */
export function gardenNamespaceAnnotationValue(namespaceName: string) {
  return `garden-namespace--${namespaceName}`
}

export function convertServiceResource(
  module: KubernetesModule | HelmModule,
  serviceResourceSpec?: ServiceResourceSpec
): KubernetesTargetResourceSpec | null {
  const s = serviceResourceSpec || module.spec.serviceResource

  if (!s) {
    return null
  }

  return {
    kind: s.kind,
    name: s.name,
    podSelector: s.podSelector,
    containerName: s.containerName,
  }
}

export async function runOrTest(
  params: CommonRunParams & {
    ctx: KubernetesPluginContext
    action: KubernetesRunAction | KubernetesTestAction
    log: LogEntry
    namespace: string
  }
) {
  const { ctx, action, log, namespace } = params
  // Get the container spec to use for running
  const spec = action.getSpec()

  let podSpec = spec.podSpec
  let container = spec.podSpec?.containers[0]

  if (!podSpec) {
    const resourceSpec = spec.resource

    if (!resourceSpec) {
      // Note: This will generally be caught in schema validation.
      throw new ConfigurationError(`${action.longDescription()} specified neither podSpec nor resource.`, { spec })
    }

    const target = await getTargetResource({
      ctx,
      log,
      provider: ctx.provider,
      action,
      query: resourceSpec,
    })

    podSpec = getResourcePodSpec(target)
    container = getResourceContainer(target, resourceSpec.containerName)
  } else if (!container) {
    throw new ConfigurationError(
      `${action.longDescription()} specified a podSpec without containers. Please make sure there is at least one container in the spec.`,
      { spec }
    )
  }

  const { timeout } = action.getConfig()

  return runAndCopy({
    ...params,
    container,
    podSpec,
    command: spec.command,
    args: spec.args,
    artifacts: spec.artifacts,
    envVars: spec.env,
    image: container.image!,
    namespace,
    podName: makePodName(action.kind.toLowerCase(), action.name),
    timeout: timeout || DEFAULT_TASK_TIMEOUT,
    version: action.versionString(),
  })
}