/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import {
  DeepPrimitiveMap,
  joi,
  joiIdentifier,
  joiModuleIncludeDirective,
  joiSparseArray,
  joiUserIdentifier,
} from "../../../config/common"
import { GardenModule } from "../../../types/module"
import { containsSource } from "./common"
import { ConfigurationError } from "../../../exceptions"
import { dedent, deline } from "../../../util/string"
import { GardenService } from "../../../types/service"
import { ContainerModule } from "../../container/moduleConfig"
import { baseBuildSpecSchema } from "../../../config/module"
import { ConfigureModuleParams, ConfigureModuleResult } from "../../../plugin/handlers/module/configure"
import {
  containerModuleSchema,
  kubernetesLocalModeSchema,
  KubernetesLocalModeSpec,
  kubernetesTaskSchema,
  KubernetesTaskSpec,
  kubernetesTestSchema,
  KubernetesTestSpec,
  PortForwardSpec,
  serviceResourceDescription,
  serviceResourceSchema,
  ServiceResourceSpec,
} from "../config"
import { posix } from "path"
import { runPodSpecIncludeFields } from "../run"
import { omit } from "lodash"
import { kubernetesModuleDevModeSchema, KubernetesModuleDevModeSpec } from "../dev-mode"
import { helmChartNameSchema, helmChartRepoSchema, helmChartVersionSchema, helmCommonSchemaKeys } from "./config"

export const defaultHelmTimeout = 300

// A Helm Module always maps to a single Service
export type HelmModuleSpec = HelmServiceSpec

export interface HelmModule
  extends GardenModule<HelmModuleSpec, HelmServiceSpec, KubernetesTestSpec, KubernetesTaskSpec> {}

export type HelmModuleConfig = HelmModule["_config"]

export interface HelmServiceSpec {
  atomicInstall: boolean
  base?: string
  chart?: string
  chartPath: string
  dependencies: string[]
  devMode?: KubernetesModuleDevModeSpec
  localMode?: KubernetesLocalModeSpec
  namespace?: string
  portForwards?: PortForwardSpec[]
  releaseName?: string
  repo?: string
  serviceResource?: ServiceResourceSpec
  skipDeploy: boolean
  tasks: KubernetesTaskSpec[]
  tests: KubernetesTestSpec[]
  timeout: number
  version?: string
  values: DeepPrimitiveMap
  valueFiles: string[]
}

export type HelmService = GardenService<HelmModule, ContainerModule>

export const helmModuleOutputsSchema = () =>
  joi.object().keys({
    "release-name": joi.string().required().description("The Helm release name of the service."),
  })

const helmServiceResourceSchema = () =>
  serviceResourceSchema().keys({
    name: joi.string().description(
      dedent`The name of the resource to sync to. If the chart contains a single resource of the specified Kind,
        this can be omitted.

        This can include a Helm template string, e.g. '{{ template "my-chart.fullname" . }}'.
        This allows you to easily match the dynamic names given by Helm. In most cases you should copy this
        directly from the template in question in order to match it. Note that you may need to add single quotes around
        the string for the YAML to be parsed correctly.`
    ),
    containerModule: containerModuleSchema(),
  })

const runPodSpecWhitelistDescription = runPodSpecIncludeFields.map((f) => `* \`${f}\``).join("\n")

const helmTaskSchema = () =>
  kubernetesTaskSchema().keys({
    resource: helmServiceResourceSchema().description(
      dedent`The Deployment, DaemonSet or StatefulSet or Pod that Garden should use to execute this task.
        If not specified, the \`serviceResource\` configured on the module will be used. If neither is specified,
        an error will be thrown.

        ${serviceResourceDescription}

        The following pod spec fields from the service resource will be used (if present) when executing the task:
        ${runPodSpecWhitelistDescription}`
    ),
  })

const helmTestSchema = () =>
  kubernetesTestSchema().keys({
    resource: helmServiceResourceSchema().description(
      dedent`The Deployment, DaemonSet or StatefulSet or Pod that Garden should use to execute this test suite.
        If not specified, the \`serviceResource\` configured on the module will be used. If neither is specified,
        an error will be thrown.

        ${serviceResourceDescription}

        The following pod spec fields from the service resource will be used (if present) when executing the test suite:
        ${runPodSpecWhitelistDescription}`
    ),
  })

export const helmModuleSpecSchema = () =>
  joi.object().keys({
    ...helmCommonSchemaKeys(),
    base: joiUserIdentifier()
      .description(
        deline`The name of another \`helm\` module to use as a base for this one. Use this to re-use a Helm chart across
      multiple services. For example, you might have an organization-wide base chart for certain types of services.

      If set, this module will by default inherit the following properties from the base module:
      \`serviceResource\`, \`values\`

      Each of those can be overridden in this module. They will be merged with a JSON Merge Patch (RFC 7396).`
      )
      .example("my-base-chart"),
    build: baseBuildSpecSchema(),
    chart: helmChartNameSchema(),
    chartPath: joi
      .posixPath()
      .subPathOnly()
      .description(
        deline`The path, relative to the module path, to the chart sources (i.e. where the Chart.yaml file is, if any).
      Not used when \`base\` is specified.`
      )
      .default("."),
    dependencies: joiSparseArray(joiIdentifier()).description(
      "List of names of services that should be deployed before this chart."
    ),
    devMode: kubernetesModuleDevModeSchema(),
    localMode: kubernetesLocalModeSchema(),
    include: joiModuleIncludeDirective(dedent`
      If neither \`include\` nor \`exclude\` is set, and the module has local chart sources, Garden
      automatically sets \`include\` to: \`["*", "charts/**/*", "templates/**/*"]\`.

      If neither \`include\` nor \`exclude\` is set and the module specifies a remote chart, Garden
      automatically sets \`ìnclude\` to \`[]\`.
    `),
    repo: helmChartRepoSchema(),
    serviceResource: helmServiceResourceSchema().description(
      dedent`
      The Deployment, DaemonSet or StatefulSet or Pod that Garden should regard as the _Garden service_ in this module (not to be confused with Kubernetes Service resources).

      ${serviceResourceDescription}

      Because a Helm chart can contain any number of Kubernetes resources, this needs to be specified for certain Garden features and commands to work.
      `
    ),
    skipDeploy: joi
      .boolean()
      .default(false)
      .description(
        deline`Set this to true if the chart should only be built, but not deployed as a service.
      Use this, for example, if the chart should only be used as a base for other modules.`
      ),
    tasks: joiSparseArray(helmTaskSchema()).description("The task definitions for this module."),
    tests: joiSparseArray(helmTestSchema()).description("The test suite definitions for this module."),
    version: helmChartVersionSchema(),
  })

export async function configureHelmModule({
  moduleConfig,
}: ConfigureModuleParams<HelmModule>): Promise<ConfigureModuleResult<HelmModule>> {
  const { base, chartPath, dependencies, serviceResource, skipDeploy, tasks, tests } = moduleConfig.spec

  const sourceModuleName = serviceResource ? serviceResource.containerModule : undefined

  if (!skipDeploy) {
    moduleConfig.serviceConfigs = [
      {
        name: moduleConfig.name,
        dependencies,
        disabled: moduleConfig.disabled,
        sourceModuleName,
        spec: moduleConfig.spec,
      },
    ]
  }

  const containsSources = await containsSource(moduleConfig)

  if (base) {
    if (containsSources) {
      throw new ConfigurationError(
        deline`
        Helm module '${moduleConfig.name}' both contains sources and specifies a base module.
        Since Helm charts cannot currently be merged, please either remove the sources or
        the \`base\` reference in your module config.
      `,
        { moduleConfig }
      )
    }

    // We copy the chart on build
    // TODO-G2: change this to validation instead, require explicit dependency
    moduleConfig.build.dependencies.push({ name: base, copy: [{ source: "*", target: "." }] })
  }

  moduleConfig.buildConfig = omit(moduleConfig.spec, [
    "atomicInstall",
    "serviceResource",
    "skipDeploy",
    "tasks",
    "tests",
  ])

  moduleConfig.taskConfigs = tasks.map((spec) => {
    if (spec.resource && spec.resource.containerModule) {
      // TODO-G2: change this to validation instead, require explicit dependency
      moduleConfig.build.dependencies.push({ name: spec.resource.containerModule, copy: [] })
    }

    return {
      name: spec.name,
      cacheResult: spec.cacheResult,
      dependencies: spec.dependencies,
      disabled: moduleConfig.disabled,
      timeout: spec.timeout,
      spec,
    }
  })

  moduleConfig.testConfigs = tests.map((spec) => {
    if (spec.resource && spec.resource.containerModule) {
      // TODO-G2: change this to validation instead, require explicit dependency
      moduleConfig.build.dependencies.push({ name: spec.resource.containerModule, copy: [] })
    }

    return {
      name: spec.name,
      dependencies: spec.dependencies,
      disabled: moduleConfig.disabled,
      timeout: spec.timeout,
      spec,
    }
  })

  const valueFiles = moduleConfig.spec.valueFiles

  // Automatically set the include if not explicitly set
  if (!(moduleConfig.include || moduleConfig.exclude)) {
    moduleConfig.include = containsSources
      ? ["*", "charts/**/*", "templates/**/*", ...valueFiles]
      : ["*.yaml", "*.yml", ...valueFiles]

    moduleConfig.include = moduleConfig.include.map((path) => posix.join(chartPath, path))
  }

  return { moduleConfig }
}