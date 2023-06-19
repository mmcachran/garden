/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import td from "testdouble"
import { join, relative, resolve } from "path"
import {
  cloneDeep,
  extend,
  forOwn,
  get,
  intersection,
  isArray,
  isNull,
  isObject,
  isString,
  isUndefined,
  mapValues,
  merge,
  omit,
  pull,
  uniq,
} from "lodash"
import { copy, ensureDir, mkdirp, pathExists, remove, truncate } from "fs-extra"

import { buildExecAction } from "../src/plugins/exec/exec"
import { convertExecModule } from "../src/plugins/exec/convert"
import { createSchema, joi, joiArray } from "../src/config/common"
import {
  createGardenPlugin,
  GardenPluginReference,
  GardenPluginSpec,
  ProviderHandlers,
  RegisterPluginParam,
} from "../src/plugin/plugin"
import { Garden } from "../src/garden"
import { ModuleConfig } from "../src/config/module"
import { ModuleVersion } from "../src/vcs/vcs"
import { DEFAULT_BUILD_TIMEOUT_SEC, GARDEN_CORE_ROOT, GardenApiVersion, gardenEnv } from "../src/constants"
import { globalOptions, GlobalOptions, Parameters, ParameterValues } from "../src/cli/params"
import { ConfigureModuleParams } from "../src/plugin/handlers/Module/configure"
import { ExternalSourceType, getRemoteSourceLocalPath, hashRepoUrl } from "../src/util/ext-source-util"
import { CommandParams, ProcessCommandResult } from "../src/commands/base"
import { SuiteFunction, TestFunction } from "mocha"
import { AnalyticsGlobalConfig } from "../src/config-store/global"
import { EventLogEntry, TestGarden, TestGardenOpts } from "../src/util/testing"
import { LogLevel, RootLogger } from "../src/logger/logger"
import { GardenCli } from "../src/cli/cli"
import { profileAsync } from "../src/util/profiling"
import { defaultDotIgnoreFile, makeTempDir } from "../src/util/fs"
import { DirectoryResult } from "tmp-promise"
import { ConfigurationError } from "../src/exceptions"
import Bluebird = require("bluebird")
import execa = require("execa")
import timekeeper = require("timekeeper")
import { execBuildSpecSchema, ExecModule, execTaskSpecSchema, execTestSchema } from "../src/plugins/exec/moduleConfig"
import {
  execBuildActionSchema,
  execDeployActionSchema,
  execDeployCommandSchema,
  ExecRun,
  execRunActionSchema,
  ExecTest,
  execTestActionSchema,
} from "../src/plugins/exec/config"
import { ManyActionTypeDefinitions, RunActionHandler, TestActionHandler } from "../src/plugin/action-types"
import { GetRunResult } from "../src/plugin/handlers/Run/get-result"
import { defaultEnvironment, defaultNamespace, ProjectConfig } from "../src/config/project"
import { ConvertModuleParams } from "../src/plugin/handlers/Module/convert"
import { baseServiceSpecSchema } from "../src/config/service"
import { localConfigFilename } from "../src/config-store/local"
import { GraphResultMapWithoutTask } from "../src/graph/results"
import { dumpYaml } from "../src/util/serialization"
import { exec } from "../src/util/util"

export { TempDirectory, makeTempDir } from "../src/util/fs"
export { TestGarden, TestError, TestEventBus, expectError, expectFuzzyMatch } from "../src/util/testing"

// TODO-G2: split test plugin into new module

const testDataDir = resolve(GARDEN_CORE_ROOT, "test", "data")
const testNow = new Date()
const testModuleVersionString = "v-1234512345"
export const testModuleVersion: ModuleVersion = {
  contentHash: testModuleVersionString,
  versionString: testModuleVersionString,
  dependencyVersions: {},
  files: [],
}

// All test projects use this git URL
export const testGitUrl = "https://example.com/my-repo.git#main"
export const testGitUrlHash = hashRepoUrl(testGitUrl)

/**
 * Returns a fully resolved path of a concrete subdirectory located in the {@link testDataDir}.
 * The concrete subdirectory path is defined as a varargs list of its directory names.
 * E.g. `"project", "service-1"` stands for the path `project/service-1`.
 *
 * @param names the subdirectory path
 */
export function getDataDir(...names: string[]) {
  return resolve(testDataDir, ...names)
}

export function getExampleDir(name: string) {
  return resolve(GARDEN_CORE_ROOT, "..", "examples", name)
}

export async function profileBlock(description: string, block: () => Promise<any>) {
  /* eslint-disable no-console */
  const startTime = new Date().getTime()
  const result = await block()
  const executionTime = new Date().getTime() - startTime
  console.log(description, "took", executionTime, "ms")
  return result
}

export const projectRootA = getDataDir("test-project-a")
export const projectRootBuildDependants = getDataDir("test-build-dependants")

export const testModuleSpecSchema = createSchema({
  name: "test:Module:spec",
  keys: () => ({
    build: execBuildSpecSchema(),
    services: joiArray(baseServiceSpecSchema()),
    tests: joiArray(execTestSchema()),
    tasks: joiArray(execTaskSpecSchema()),
  }),
})

export const testDeploySchema = createSchema({
  name: "test.Deploy",
  extend: execDeployActionSchema,
  keys: () => ({
    // Making this optional for tests
    deployCommand: execDeployCommandSchema().optional(),
  }),
})
export const testRunSchema = createSchema({
  name: "test.Run",
  extend: execRunActionSchema,
  keys: () => ({}),
})
export const testTestSchema = createSchema({
  name: "test.Test",
  extend: execTestActionSchema,
  keys: () => ({}),
})

export async function configureTestModule({ moduleConfig }: ConfigureModuleParams) {
  // validate services
  moduleConfig.serviceConfigs = moduleConfig.spec.services.map((spec) => ({
    name: spec.name,
    dependencies: spec.dependencies,
    disabled: spec.disabled,
    sourceModuleName: spec.sourceModuleName,
    timeout: spec.timeout,
    spec,
  }))

  moduleConfig.taskConfigs = moduleConfig.spec.tasks.map((spec) => ({
    name: spec.name,
    dependencies: spec.dependencies,
    disabled: spec.disabled,
    timeout: spec.timeout,
    spec,
  }))

  moduleConfig.testConfigs = moduleConfig.spec.tests.map((spec) => ({
    name: spec.name,
    dependencies: spec.dependencies,
    disabled: spec.disabled,
    timeout: spec.timeout,
    spec,
  }))

  return { moduleConfig }
}

const runTest: RunActionHandler<"run", ExecRun> = async ({ action, log }): Promise<GetRunResult> => {
  const { command } = action.getSpec()

  const commandStr = isString(command) ? command : command.join(" ")

  log.info("Run command: " + commandStr)

  const outputs = {
    log: commandStr,
  }

  return {
    state: "ready",
    detail: {
      ...outputs,
      completedAt: testNow,
      startedAt: testNow,
      success: true,
    },
    outputs,
  }
}

const testBuildStaticOutputsSchema = createSchema({
  name: "test:Build:static-outputs",
  keys: () => ({
    foo: joi.string(),
  }),
})

const testPluginSecrets: { [key: string]: string } = {}

export const testPlugin = () =>
  createGardenPlugin({
    name: "test-plugin",
    dashboardPages: [
      {
        name: "test",
        description: "Test dashboard page",
        title: "Test",
        newWindow: false,
      },
    ],
    handlers: {
      async configureProvider({ config }) {
        for (let member in testPluginSecrets) {
          delete testPluginSecrets[member]
        }
        return { config }
      },

      async getDashboardPage({ page }) {
        return { url: `http://localhost:12345/${page.name}` }
      },

      async getEnvironmentStatus() {
        return { ready: true, outputs: { testKey: "testValue" } }
      },

      async prepareEnvironment() {
        return { status: { ready: true, outputs: { testKey: "testValue" } } }
      },

      async getDebugInfo() {
        return {
          info: {
            exampleData: "data",
            exampleData2: "data2",
          },
        }
      },
    },

    createActionTypes: {
      Build: [
        {
          name: "test",
          docs: "Test Build action",
          schema: execBuildActionSchema(),
          staticOutputsSchema: testBuildStaticOutputsSchema(),
          handlers: {
            build: buildExecAction,
            getStatus: async ({ ctx, action }) => {
              const result = get(ctx.provider, ["_actionStatuses", action.kind, action.name])
              return result || { state: "not-ready", detail: null, outputs: {} }
            },
            getOutputs: async (_) => {
              return { outputs: { foo: "bar" } }
            },
          },
        },
      ],
      Deploy: [
        {
          name: "test",
          docs: "Test Deploy action",
          schema: testDeploySchema(),
          handlers: {
            configure: async ({ config }) => {
              return { config, supportedModes: { sync: !!config.spec.syncMode, local: true } }
            },
            deploy: async ({}) => {
              return { state: "ready", detail: { state: "ready", detail: {} }, outputs: {} }
            },
            getStatus: async ({ ctx, action }) => {
              const result = get(ctx.provider, ["_actionStatuses", action.kind, action.name])
              return result || { state: "ready", detail: { state: "ready", detail: {} }, outputs: {} }
            },
            exec: async ({ command }) => {
              return { code: 0, output: "Ran command: " + command.join(" ") }
            },
          },
        },
      ],
      Run: [
        {
          name: "test",
          docs: "Test Run action",
          schema: testRunSchema(),
          handlers: {
            run: runTest,
            getResult: async ({ ctx, action }) => {
              const result = get(ctx.provider, ["_actionStatuses", action.kind, action.name])
              return result || { state: "not-ready", detail: null, outputs: {} }
            },
          },
        },
      ],
      Test: [
        {
          name: "test",
          docs: "Test Test action",
          schema: testTestSchema(),
          handlers: {
            run: <TestActionHandler<"run", ExecTest>>(<unknown>runTest),
            getResult: async ({ ctx, action }) => {
              const result = get(ctx.provider, ["_actionStatuses", action.kind, action.name])
              return result || { state: "not-ready", detail: null, outputs: {} }
            },
          },
        },
      ],
    },

    createModuleTypes: [
      {
        name: "test",
        docs: "Test module type",
        schema: testModuleSpecSchema(),
        needsBuild: true,
        handlers: {
          // We want all the actions from the exec conversion.
          convert: async (params: ConvertModuleParams) => {
            const module: ExecModule = params.module
            const result = await convertExecModule({ ...params, module })
            // Override action type
            for (const action of result.group.actions) {
              action.type = <any>"test"
            }
            return result
          },
          configure: configureTestModule,

          async getModuleOutputs() {
            return { outputs: { foo: "bar" } }
          },
        },
      },
    ],
  })

export const customizedTestPlugin = (partialCustomSpec: Partial<GardenPluginSpec>) => {
  const base = testPlugin()
  merge(base, partialCustomSpec)
  return base
}

export const testPluginB = () => {
  const base = testPlugin()

  return createGardenPlugin({
    ...base,
    name: "test-plugin-b",
    dependencies: [{ name: "test-plugin" }],
    createModuleTypes: [],
    createActionTypes: {},
  })
}

export const testPluginC = () => {
  const base = testPlugin()

  return createGardenPlugin({
    ...base,
    name: "test-plugin-c",
    // TODO-G2: change to create action types
    createModuleTypes: [
      {
        name: "test-c",
        docs: "Test module type C",
        schema: testModuleSpecSchema(),
        handlers: base.createModuleTypes![0].handlers,
        needsBuild: true,
      },
    ],
    createActionTypes: {},
  })
}

export const getDefaultProjectConfig = (): ProjectConfig =>
  cloneDeep({
    apiVersion: GardenApiVersion.v1,
    kind: "Project",
    name: "test",
    path: "tmp",
    defaultEnvironment,
    dotIgnoreFile: defaultDotIgnoreFile,
    environments: [{ name: "default", defaultNamespace, variables: {} }],
    providers: [{ name: "test-plugin", dependencies: [] }],
    variables: {},
  })

export const createProjectConfig = (partialCustomConfig: Partial<ProjectConfig>): ProjectConfig => {
  const baseConfig = getDefaultProjectConfig()
  return merge(baseConfig, partialCustomConfig)
}

export const defaultModuleConfig: ModuleConfig = {
  apiVersion: GardenApiVersion.v0,
  type: "test",
  name: "test",
  path: "bla",
  allowPublish: false,
  build: { dependencies: [], timeout: DEFAULT_BUILD_TIMEOUT_SEC },
  disabled: false,
  spec: {
    services: [
      {
        name: "test-service",
        dependencies: [],
      },
    ],
    tests: [],
    tasks: [],
  },
  serviceConfigs: [
    {
      name: "test-service",
      dependencies: [],
      disabled: false,
      spec: {},
    },
  ],
  testConfigs: [],
  taskConfigs: [],
}

export const makeTestModule = (params: Partial<ModuleConfig> = {}): ModuleConfig => {
  // deep merge `params` config into `defaultModuleConfig`
  return merge(cloneDeep(defaultModuleConfig), params)
}

/**
 * Similar to {@link makeTestModule}, but uses a more minimal default config.
 * @param path the project root path
 * @param from the partial module config to override the default values
 */
export function makeModuleConfig<M extends ModuleConfig = ModuleConfig>(path: string, from: Partial<M>): ModuleConfig {
  return {
    // NOTE: this apiVersion field is distinct from the apiVersion field in the
    // project configuration, is currently unused and has no meaning.
    // It is hidden in our reference docs.
    apiVersion: GardenApiVersion.v0,
    allowPublish: false,
    build: { dependencies: [] },
    disabled: false,
    include: [],
    name: "test",
    path,
    serviceConfigs: [],
    taskConfigs: [],
    spec: {},
    testConfigs: [],
    type: "test",
    ...from,
  }
}

export const testPluginReferences: () => GardenPluginReference[] = () =>
  [testPlugin, testPluginB, testPluginC].map((p) => {
    const plugin = p()
    return { name: plugin.name, callback: p }
  })
export const testPlugins = () => testPluginReferences().map((p) => p.callback())

export const testProjectTempDirs: { [root: string]: DirectoryResult } = {}

/**
 * Create a garden instance for testing and setup a project if it doesn't exist already.
 */
export const makeTestGarden = profileAsync(async function _makeTestGarden(
  projectRoot: string,
  opts: TestGardenOpts = {}
): Promise<TestGarden> {
  let targetRoot = projectRoot

  if (!opts.noTempDir) {
    if (!testProjectTempDirs[projectRoot]) {
      // Clone the project root to a temp directory
      testProjectTempDirs[projectRoot] = await makeTempDir({ git: true })
      targetRoot = join(testProjectTempDirs[projectRoot].path, "project")
      await ensureDir(targetRoot)

      await copy(projectRoot, targetRoot, {
        // Don't copy the .garden directory if it exists
        filter: (src: string) => {
          const relSrc = relative(projectRoot, src)
          return relSrc !== ".garden"
        },
      })

      // Add files to git to avoid having to hash all the files
      await exec("git", ["add", "."], { cwd: targetRoot })
      // Note: This will error if there are no files added, hence reject=false
      await exec("git", ["commit", "-m", "copied"], { cwd: targetRoot, reject: false })

      if (opts.config?.path) {
        opts.config.path = targetRoot
      }
      if (opts.config?.configPath) {
        throw new ConfigurationError(`Please don't set the configPath here :) Messes with the temp dir business.`, {})
      }
    }
    targetRoot = join(testProjectTempDirs[projectRoot].path, "project")
  }

  const plugins = opts.onlySpecifiedPlugins ? opts.plugins : [...testPlugins(), ...(opts.plugins || [])]

  return TestGarden.factory(targetRoot, { ...opts, plugins })
})

export const makeTestGardenA = profileAsync(async function _makeTestGardenA(
  extraPlugins: RegisterPluginParam[] = [],
  opts?: TestGardenOpts
) {
  return makeTestGarden(projectRootA, { plugins: extraPlugins, forceRefresh: true, ...opts })
})

export const makeTestGardenBuildDependants = profileAsync(async function _makeTestGardenBuildDependants(
  extraPlugins: RegisterPluginParam[] = [],
  opts?: TestGardenOpts
) {
  return makeTestGarden(projectRootBuildDependants, { plugins: extraPlugins, forceRefresh: true, ...opts })
})

/**
 * Creates a new TestGarden instance from a temporary path, with a default project config.
 */
export async function makeTempGarden(opts?: TestGardenOpts) {
  const tmpDir = await makeTempDir({ git: true })
  await dumpYaml(join(tmpDir.path, "project.garden.yml"), opts?.config || getDefaultProjectConfig())
  const garden = await makeTestGarden(tmpDir.path, opts)
  return { tmpDir, garden }
}

export async function stubProviderAction<T extends keyof ProviderHandlers>(
  garden: Garden,
  pluginName: string,
  type: T,
  handler?: ProviderHandlers[T]
) {
  if (handler) {
    handler["pluginName"] = pluginName
  }
  const actions = await garden.getActionRouter()
  return td.replace(actions.provider["pluginHandlers"][type], pluginName, handler)
}

/**
 * Returns an alphabetically sorted list of all processed actions including dependencies from a GraphResultMap.
 */
export function getAllProcessedTaskNames(results: GraphResultMapWithoutTask) {
  const all = Object.keys(results)

  for (const r of Object.values(results)) {
    if (r?.dependencyResults) {
      all.push(...getAllProcessedTaskNames(r.dependencyResults))
    }
  }

  return uniq(all).sort()
}

/**
 * Returns a map of all task results including dependencies from a GraphResultMap.
 */
export function getAllTaskResults(results: GraphResultMapWithoutTask) {
  const all = { ...results }

  for (const r of Object.values(results)) {
    if (r?.dependencyResults) {
      for (const [key, result] of Object.entries(getAllTaskResults(r.dependencyResults))) {
        all[key] = result
      }
    }
  }

  return all
}

export function taskResultOutputs(results: ProcessCommandResult) {
  return mapValues(results.graphResults, (r) => r?.result && omit(r.result, "executedAction"))
}

export const cleanProject = async (gardenDirPath: string) => {
  return remove(gardenDirPath)
}

export function withDefaultGlobalOpts<T extends object>(opts: T) {
  return <ParameterValues<GlobalOptions> & T>extend(
    mapValues(globalOptions, (opt) => opt.defaultValue),
    opts
  )
}

export function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform })
}

export function freezeTime(date?: Date) {
  if (!date) {
    date = new Date()
  }
  timekeeper.freeze(date)
  return date
}

export async function resetLocalConfig(gardenDirPath: string) {
  const path = join(gardenDirPath, localConfigFilename)
  if (await pathExists(path)) {
    await truncate(path)
  }
}

/**
 * Idempotently initializes the test-projects/ext-project-sources project and returns
 * the Garden class.
 */
export async function makeExtProjectSourcesGarden(opts: TestGardenOpts = {}) {
  const projectRoot = getDataDir("test-projects", "ext-project-sources")
  // Borrow the external sources from here:
  const extSourcesRoot = getDataDir("test-projects", "local-project-sources")
  const sourceNames = ["source-a", "source-b", "source-c"]
  return prepareRemoteGarden({ projectRoot, extSourcesRoot, sourceNames, type: "project", opts })
}

/**
 * Idempotently initializes the test-project/ext-action-sources project and returns
 * the Garden class.
 */
export async function makeExtActionSourcesGarden(opts: TestGardenOpts = {}) {
  const projectRoot = getDataDir("test-projects", "ext-action-sources")
  // Borrow the external sources from here:
  const extSourcesRoot = getDataDir("test-projects", "local-action-sources")
  const sourceNames = ["build.a", "build.b"]
  return prepareRemoteGarden({ projectRoot, extSourcesRoot, sourceNames, type: "action", opts })
}

/**
 * Idempotently initializes the test-projects/ext-project-sources project and returns
 * the Garden class.
 */
export async function makeExtModuleSourcesGarden(opts: TestGardenOpts = {}) {
  const projectRoot = getDataDir("test-projects", "ext-module-sources")
  // Borrow the external sources from here:
  const extSourcesRoot = getDataDir("test-projects", "local-module-sources")
  const sourceNames = ["module-a", "module-b", "module-c"]
  return prepareRemoteGarden({ projectRoot, extSourcesRoot, sourceNames, type: "module", opts })
}

/**
 * Helper function for idempotently initializing the ext-sources projects.
 * Copies the external sources into the .garden directory and git inits them.
 */
async function prepareRemoteGarden({
  projectRoot,
  extSourcesRoot,
  sourceNames,
  type,
  opts = {},
}: {
  projectRoot: string
  extSourcesRoot: string
  sourceNames: string[]
  type: ExternalSourceType
  opts?: TestGardenOpts
}) {
  const garden = await makeTestGarden(projectRoot, opts)
  const sourcesPath = join(garden.projectRoot, ".garden", "sources", type)

  await mkdirp(sourcesPath)
  // Copy the sources to the `.garden/sources` dir and git init them
  await Bluebird.map(sourceNames, async (name) => {
    const targetPath = getRemoteSourceLocalPath({ gardenDirPath: garden.gardenDirPath, name, url: testGitUrl, type })
    await copy(join(extSourcesRoot, name), targetPath)
    await execa("git", ["init", "--initial-branch=main"], { cwd: targetPath })
  })

  return garden
}

/**
 * Trims the ends of each line of the given input string (useful for multi-line string comparisons)
 */
export function trimLineEnds(str: string) {
  return str
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
}

const skipGroups = gardenEnv.GARDEN_SKIP_TESTS.split(" ")

// Modified version of https://stackoverflow.com/a/26202058
/**
 * Recursively remove null or undefined values from an object (inluding array elements).
 */
export function pruneEmpty(obj) {
  return (function prune(current) {
    forOwn(current, function (value, key) {
      if (isObject(value)) {
        prune(value)
      } else if (isUndefined(value) || isNull(value)) {
        delete current[key]
      }
    })
    // remove any leftover undefined values from the delete operation on an array
    if (isArray(current)) {
      pull(current, undefined)
    }
    return current
  })(obj)
}

/**
 * Helper function that wraps mocha functions and assigns them to one or more groups.
 *
 * If any of the specified `groups` are included in the `GARDEN_SKIP_TESTS` environment variable
 * (which should be specified as a space-delimited string, e.g. `GARDEN_SKIP_TESTS="group-a group-b"`),
 * the test or suite is skipped.
 *
 * Usage example:
 *
 *   // Skips the test if GARDEN_SKIP_TESTS=some-group
 *   grouped("some-group").it("should do something", () => { ... })
 *
 * @param groups   The group or groups of the test/suite (specify one string or array of strings)
 */
export function grouped(...groups: string[]) {
  const wrapTest = (fn: TestFunction) => {
    if (intersection(groups, skipGroups).length > 0) {
      return fn.skip
    } else {
      return fn
    }
  }

  const wrapSuite = (fn: SuiteFunction) => {
    if (intersection(groups, skipGroups).length > 0) {
      return fn.skip
    } else {
      return fn
    }
  }

  return {
    it: wrapTest(it),
    describe: wrapSuite(describe),
    context: wrapSuite(context),
  }
}

/**
 * Helper function that enables analytics while testing by updating the global config
 * and setting the appropriate environment variables.
 *
 * Returns a reset function that resets the config and environment variables to their
 * previous state.
 *
 * Call this function in a `before` hook and the reset function in an `after` hook.
 *
 * NOTE: Network calls to the analytics endpoint should be mocked when unit testing analytics.
 */
export async function enableAnalytics(garden: TestGarden) {
  const originalDisableAnalyticsEnvVar = gardenEnv.GARDEN_DISABLE_ANALYTICS
  const originalAnalyticsDevEnvVar = gardenEnv.ANALYTICS_DEV

  let originalAnalyticsConfig: AnalyticsGlobalConfig | undefined
  // Throws if analytics is not set
  try {
    // Need to clone object!
    originalAnalyticsConfig = { ...(await garden.globalConfigStore.get("analytics")) }
  } catch {}

  gardenEnv.GARDEN_DISABLE_ANALYTICS = false
  // Set the analytics mode to dev for good measure
  gardenEnv.ANALYTICS_DEV = true

  const resetConfig = async () => {
    if (originalAnalyticsConfig) {
      await garden.globalConfigStore.set("analytics", originalAnalyticsConfig)
    } else {
      await garden.globalConfigStore.set("analytics", {})
    }
    gardenEnv.GARDEN_DISABLE_ANALYTICS = originalDisableAnalyticsEnvVar
    gardenEnv.ANALYTICS_DEV = originalAnalyticsDevEnvVar
  }
  return resetConfig
}

export function findNamespaceStatusEvent(eventLog: EventLogEntry[], namespaceName: string) {
  return eventLog.find((e) => e.name === "namespaceStatus" && e.payload.namespaceName === namespaceName)
}

/**
 * Initialise test logger.
 *
 * It doesn't register any writers so it only collects logs but doesn't write them.
 */
export function initTestLogger() {
  // make sure logger is initialized
  try {
    RootLogger.initialize({
      level: LogLevel.info,
      storeEntries: true,
      displayWriterType: "quiet",
      force: true,
    })
  } catch (_) {}
}

export function makeCommandParams<T extends Parameters = {}, U extends Parameters = {}>({
  cli,
  garden,
  args,
  opts,
}: {
  cli?: GardenCli
  garden: Garden
  args: T
  opts: U
}): CommandParams<T, U> {
  const log = garden.log
  return {
    cli,
    garden,
    log,
    args,
    opts: withDefaultGlobalOpts(opts),
  }
}

type NameOfProperty = string
// https://stackoverflow.com/a/66836940
// useful for typesafe stubbing
export function getPropertyName<T extends {}>(
  obj: T,
  expression: (x: { [Property in keyof T]: () => string }) => () => NameOfProperty
): string {
  const res: { [Property in keyof T]: () => string } = {} as { [Property in keyof T]: () => string }

  Object.keys(obj).map((k) => (res[k as keyof T] = () => k))

  return expression(res)()
}

export function getEmptyPluginActionDefinitions(name: string): ManyActionTypeDefinitions {
  return {
    Build: [{ docs: "blah", handlers: {}, name, schema: joi.object() }],
    Test: [{ docs: "blah", handlers: {}, name, schema: joi.object() }],
    Deploy: [{ docs: "blah", handlers: {}, name, schema: joi.object() }],
    Run: [{ docs: "blah", handlers: {}, name, schema: joi.object() }],
  }
}
