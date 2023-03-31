/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Bluebird from "bluebird"
import chalk from "chalk"
import { ensureDir, readdir } from "fs-extra"
import dedent from "dedent"
import { platform, arch } from "os"
import { relative, resolve } from "path"
import { flatten, sortBy, keyBy, mapValues, cloneDeep, groupBy, uniq } from "lodash"
const AsyncLock = require("async-lock")

import { TreeCache } from "./cache"
import { getBuiltinPlugins } from "./plugins/plugins"
import { GardenModule, getModuleCacheContext, ModuleConfigMap, ModuleTypeMap } from "./types/module"
import {
  SourceConfig,
  ProjectConfig,
  resolveProjectConfig,
  pickEnvironment,
  OutputSpec,
  EnvironmentConfig,
  parseEnvironment,
  getDefaultEnvironmentName,
  projectSourcesSchema,
  ProxyConfig,
} from "./config/project"
import {
  findByName,
  pickKeys,
  getPackageVersion,
  getNames,
  findByNames,
  duplicatesByKey,
  getCloudDistributionName,
  getCloudLogSectionName,
} from "./util/util"
import { ConfigurationError, PluginError, RuntimeError } from "./exceptions"
import { VcsHandler, ModuleVersion, getModuleVersionString, VcsInfo } from "./vcs/vcs"
import { GitHandler } from "./vcs/git"
import { BuildStaging } from "./build-staging/build-staging"
import { ConfigGraph, ResolvedConfigGraph } from "./graph/config-graph"
import { getLogger } from "./logger/logger"
import { ProviderHandlers, GardenPlugin } from "./plugin/plugin"
import {
  loadConfigResources,
  findProjectConfig,
  GardenResource,
  configTemplateKind,
  renderTemplateKind,
} from "./config/base"
import { DeepPrimitiveMap, StringMap, PrimitiveMap, treeVersionSchema, joi, allowUnknown } from "./config/common"
import { GlobalConfigStore } from "./config-store/global"
import { LocalConfigStore, LinkedSource } from "./config-store/local"
import { getLinkedSources, ExternalSourceType } from "./util/ext-source-util"
import { ModuleConfig } from "./config/module"
import { convertModules, ModuleResolver } from "./resolve-module"
import { createPluginContext, CommandInfo, PluginEventBroker } from "./plugin-context"
import { ModuleActionHandlers, RegisterPluginParam } from "./plugin/plugin"
import {
  SUPPORTED_PLATFORMS,
  SupportedPlatform,
  DEFAULT_GARDEN_DIR_NAME,
  gardenEnv,
  SupportedArchitecture,
  SUPPORTED_ARCHITECTURES,
} from "./constants"
import { Log } from "./logger/log-entry"
import { EventBus } from "./events"
import { Watcher } from "./watch"
import {
  findConfigPathsInPath,
  getWorkingCopyId,
  fixedProjectExcludes,
  detectModuleOverlap,
  ModuleOverlap,
  defaultConfigFilename,
} from "./util/fs"
import {
  Provider,
  GenericProviderConfig,
  getAllProviderDependencyNames,
  defaultProvider,
  ProviderMap,
} from "./config/provider"
import { ResolveProviderTask } from "./tasks/resolve-provider"
import { ActionRouter } from "./router/router"
import {
  loadAndResolvePlugins,
  getDependencyOrder,
  getModuleTypes,
  loadPlugin,
  getActionTypes,
  ActionDefinitionMap,
  getActionTypeBases,
  ActionTypeMap,
} from "./plugins"
import { deline, naturalList, wordWrap } from "./util/string"
import { DependencyGraph } from "./graph/common"
import { Profile, profileAsync } from "./util/profiling"
import username from "username"
import {
  throwOnMissingSecretKeys,
  resolveTemplateString,
  resolveTemplateStrings,
} from "./template-string/template-string"
import { WorkflowConfig, WorkflowConfigMap, resolveWorkflowConfig, isWorkflowConfig } from "./config/workflow"
import { PluginTool, PluginTools } from "./util/ext-tools"
import { ConfigTemplateResource, resolveConfigTemplate, ConfigTemplateConfig } from "./config/config-template"
import { TemplatedModuleConfig } from "./plugins/templated"
import { BuildStagingRsync } from "./build-staging/rsync"
import {
  DefaultEnvironmentContext,
  ProjectConfigContext,
  RemoteSourceConfigContext,
} from "./config/template-contexts/project"
import { CloudApi, CloudProject, CloudApiDuplicateProjectsError, getGardenCloudDomain } from "./cloud/api"
import { OutputConfigContext } from "./config/template-contexts/module"
import { ProviderConfigContext } from "./config/template-contexts/provider"
import { getSecrets } from "./cloud/get-secrets"
import { ConfigContext } from "./config/template-contexts/base"
import { validateSchema, validateWithPath } from "./config/validation"
import { pMemoizeDecorator } from "./lib/p-memoize"
import { ModuleGraph } from "./graph/modules"
import {
  Action,
  ActionConfigMap,
  ActionConfigsByKey,
  ActionKind,
  actionKinds,
  ActionModeMap,
  BaseActionConfig,
} from "./actions/types"
import { actionReferenceToString, isActionConfig } from "./actions/base"
import { GraphSolver, SolveOpts, SolveParams, SolveResult } from "./graph/solver"
import { actionConfigsToGraph, actionFromConfig, executeAction, resolveAction, resolveActions } from "./graph/actions"
import { ActionTypeDefinition } from "./plugin/action-types"
import { Task } from "./tasks/base"
import { GraphResultFromTask, GraphResults } from "./graph/results"
import { uuidv4 } from "./util/random"
import { convertTemplatedModuleToRender, RenderTemplateConfig, renderConfigTemplate } from "./config/render-template"

const defaultLocalAddress = "localhost"

export interface ActionHandlerMap<T extends keyof ProviderHandlers> {
  [actionName: string]: ProviderHandlers[T]
}

export interface ModuleActionHandlerMap<T extends keyof ModuleActionHandlers> {
  [actionName: string]: ModuleActionHandlers[T]
}

export type PluginActionMap = {
  [A in keyof ProviderHandlers]: {
    [pluginName: string]: ProviderHandlers[A]
  }
}

export interface GardenOpts {
  commandInfo: CommandInfo
  config?: ProjectConfig
  disablePortForwards?: boolean
  environmentName?: string
  forceRefresh?: boolean
  gardenDirPath?: string
  globalConfigStore?: GlobalConfigStore
  legacyBuildSync?: boolean
  log?: Log
  noEnterprise?: boolean
  persistent?: boolean
  plugins?: RegisterPluginParam[]
  sessionId?: string
  variables?: PrimitiveMap
  cloudApi?: CloudApi
}

export interface GardenParams {
  artifactsPath: string
  vcsInfo: VcsInfo
  projectId?: string
  cloudDomain?: string
  cache: TreeCache
  disablePortForwards?: boolean
  dotIgnoreFile: string
  proxy: ProxyConfig
  environmentName: string
  environmentConfigs: EnvironmentConfig[]
  namespace: string
  gardenDirPath: string
  globalConfigStore?: GlobalConfigStore
  localConfigStore?: LocalConfigStore
  log: Log
  moduleIncludePatterns?: string[]
  moduleExcludePatterns?: string[]
  opts: GardenOpts
  outputs: OutputSpec[]
  plugins: RegisterPluginParam[]
  production: boolean
  projectName: string
  projectRoot: string
  projectSources?: SourceConfig[]
  providerConfigs: GenericProviderConfig[]
  variables: DeepPrimitiveMap
  cliVariables: DeepPrimitiveMap
  secrets: StringMap
  sessionId: string
  username: string | undefined
  workingCopyId: string
  forceRefresh?: boolean
  cloudApi?: CloudApi | null
}

@Profile()
export class Garden {
  public log: Log
  private loadedPlugins: GardenPlugin[]
  protected actionConfigs: ActionConfigMap
  protected moduleConfigs: ModuleConfigMap
  protected workflowConfigs: WorkflowConfigMap
  private resolvedProviders: { [key: string]: Provider }
  protected configsScanned: boolean
  protected registeredPlugins: RegisterPluginParam[]
  private readonly solver: GraphSolver
  private watcher: Watcher
  private asyncLock: any
  public readonly projectId?: string
  public readonly cloudDomain?: string
  public sessionId: string
  public readonly localConfigStore: LocalConfigStore
  public globalConfigStore: GlobalConfigStore
  public readonly vcs: VcsHandler
  public readonly cache: TreeCache
  public readonly events: EventBus
  private tools: { [key: string]: PluginTool }
  public configTemplates: { [name: string]: ConfigTemplateConfig }
  private actionTypeBases: ActionTypeMap<ActionTypeDefinition<any>[]>

  public readonly production: boolean
  public readonly projectRoot: string
  public readonly projectName: string
  public readonly environmentName: string
  public readonly environmentConfigs: EnvironmentConfig[]
  public readonly namespace: string
  public readonly variables: DeepPrimitiveMap
  // Any variables passed via the `--var` CLI option (maintained here so that they can be used during module resolution
  // to override module variables and module varfiles).
  public readonly cliVariables: DeepPrimitiveMap
  public readonly secrets: StringMap
  private readonly projectSources: SourceConfig[]
  public readonly buildStaging: BuildStaging
  public readonly gardenDirPath: string
  public readonly artifactsPath: string
  public readonly vcsInfo: VcsInfo
  public readonly opts: GardenOpts
  private readonly providerConfigs: GenericProviderConfig[]
  public readonly workingCopyId: string
  public readonly dotIgnoreFile: string
  public readonly proxy: ProxyConfig
  public readonly moduleIncludePatterns?: string[]
  public readonly moduleExcludePatterns: string[]
  public readonly persistent: boolean
  public readonly rawOutputs: OutputSpec[]
  public readonly systemNamespace: string
  public readonly username?: string
  public readonly version: string
  private readonly forceRefresh: boolean
  public readonly cloudApi: CloudApi | null
  public readonly disablePortForwards: boolean
  public readonly commandInfo: CommandInfo

  // Used internally for introspection
  public readonly isGarden: true

  constructor(params: GardenParams) {
    this.projectId = params.projectId
    this.cloudDomain = params.cloudDomain
    this.sessionId = params.sessionId
    this.environmentName = params.environmentName
    this.environmentConfigs = params.environmentConfigs
    this.namespace = params.namespace
    this.gardenDirPath = params.gardenDirPath
    this.log = params.log
    this.artifactsPath = params.artifactsPath
    this.vcsInfo = params.vcsInfo
    this.opts = params.opts
    this.rawOutputs = params.outputs
    this.production = params.production
    this.projectName = params.projectName
    this.projectRoot = params.projectRoot
    this.projectSources = params.projectSources || []
    this.providerConfigs = params.providerConfigs
    this.variables = params.variables
    this.cliVariables = params.cliVariables
    this.secrets = params.secrets
    this.workingCopyId = params.workingCopyId
    this.dotIgnoreFile = params.dotIgnoreFile
    this.proxy = params.proxy
    this.moduleIncludePatterns = params.moduleIncludePatterns
    this.moduleExcludePatterns = params.moduleExcludePatterns || []
    this.persistent = !!params.opts.persistent
    this.username = params.username
    this.forceRefresh = !!params.forceRefresh
    this.cloudApi = params.cloudApi || null
    this.commandInfo = params.opts.commandInfo
    this.cache = params.cache
    this.isGarden = true
    this.configTemplates = {}

    this.asyncLock = new AsyncLock()

    this.vcs = new GitHandler({
      garden: this,
      projectRoot: params.projectRoot,
      gardenDirPath: params.gardenDirPath,
      ignoreFile: params.dotIgnoreFile,
      cache: params.cache,
    })

    // Use the legacy build sync mode if
    // A) GARDEN_LEGACY_BUILD_STAGE=true is set or
    // B) if running Windows and GARDEN_EXPERIMENTAL_BUILD_STAGE != true (until #2299 is properly fixed)
    const legacyBuildSync =
      params.opts.legacyBuildSync === undefined
        ? gardenEnv.GARDEN_LEGACY_BUILD_STAGE || (platform() === "win32" && !gardenEnv.GARDEN_EXPERIMENTAL_BUILD_STAGE)
        : params.opts.legacyBuildSync

    const buildDirCls = legacyBuildSync ? BuildStagingRsync : BuildStaging
    if (legacyBuildSync) {
      this.log.silly(`Using rsync build staging mode`)
    }
    this.buildStaging = new buildDirCls(params.projectRoot, params.gardenDirPath)

    // make sure we're on a supported platform
    const currentPlatform = platform()
    const currentArch = arch()

    if (!SUPPORTED_PLATFORMS.includes(<SupportedPlatform>currentPlatform)) {
      throw new RuntimeError(`Unsupported platform: ${currentPlatform}`, { platform: currentPlatform })
    }

    if (!SUPPORTED_ARCHITECTURES.includes(<SupportedArchitecture>currentArch)) {
      throw new RuntimeError(`Unsupported CPU architecture: ${currentArch}`, { arch: currentArch })
    }

    this.configsScanned = false
    // TODO: Support other VCS options.
    this.localConfigStore = params.localConfigStore || new LocalConfigStore(this.gardenDirPath)
    this.globalConfigStore = params.globalConfigStore || new GlobalConfigStore()

    this.actionConfigs = {
      Build: {},
      Deploy: {},
      Run: {},
      Test: {},
    }
    this.actionTypeBases = {
      Build: {},
      Deploy: {},
      Run: {},
      Test: {},
    }
    this.moduleConfigs = {}
    this.workflowConfigs = {}
    this.registeredPlugins = [...getBuiltinPlugins(), ...params.plugins]
    this.resolvedProviders = {}

    this.solver = new GraphSolver(this)
    this.events = new EventBus()

    // TODO: actually resolve version, based on the VCS version of the plugin and its dependencies
    this.version = getPackageVersion()

    this.disablePortForwards = gardenEnv.GARDEN_DISABLE_PORT_FORWARDS || params.disablePortForwards || false
  }

  static async factory<T extends typeof Garden>(
    this: T,
    currentDirectory: string,
    opts: GardenOpts
  ): Promise<InstanceType<T>> {
    const garden = new this(await resolveGardenParams(currentDirectory, opts)) as InstanceType<T>

    // Make sure the project root is in a git repo
    await garden.getRepoRoot()

    return garden
  }

  /**
   * Clean up before shutting down.
   */
  async close() {
    this.events.removeAllListeners()
    this.watcher && (await this.watcher.stop())
  }

  /**
   * Get the repository root for the project.
   */
  async getRepoRoot() {
    return this.vcs.getRepoRoot(this.log, this.projectRoot)
  }

  /**
   * Returns a new PluginContext, i.e. the `ctx` object that's passed to plugin handlers.
   *
   * The object contains a helper to resolve template strings. By default the templating context is set to the
   * provider template context. Callers should specify the appropriate templating for the handler that will be
   * called with the PluginContext.
   */
  async getPluginContext({
    provider,
    templateContext,
    events,
  }: {
    provider: Provider
    templateContext: ConfigContext | undefined
    events: PluginEventBroker | undefined
  }) {
    return createPluginContext({
      garden: this,
      provider,
      command: this.opts.commandInfo,
      templateContext: templateContext || new ProviderConfigContext(this, provider.dependencies, this.variables),
      events,
    })
  }

  getProjectConfigContext() {
    const loggedIn = this.isLoggedIn()
    const enterpriseDomain = this.cloudApi?.domain
    return new ProjectConfigContext({ ...this, loggedIn, enterpriseDomain })
  }

  async clearBuilds() {
    return this.buildStaging.clear()
  }

  clearCaches() {
    this.cache.clear()
    this.solver.clearCache()
  }

  async emitWarning({ key, log, message }: { key: string; log: Log; message: string }) {
    const existing = await this.localConfigStore.get("warnings", key)

    if (!existing || !existing.hidden) {
      log.warn(
        chalk.yellow(message + `\nRun ${chalk.underline(`garden util hide-warning ${key}`)} to disable this warning.`)
      )
    }
  }

  async hideWarning(key: string) {
    await this.localConfigStore.set("warnings", key, { hidden: true })
  }

  // TODO: would be nice if this returned a type based on the input tasks
  async processTasks(params: SolveParams): Promise<SolveResult> {
    return this.solver.solve(params)
  }

  async processTask<T extends Task>(task: T, log: Log, opts: SolveOpts): Promise<GraphResultFromTask<T> | null> {
    const { results } = await this.solver.solve({ tasks: [task], log, ...opts })
    return results.getResult(task)
  }

  /**
   * Enables the file watcher for the project.
   * Make sure to stop it using `.close()` when cleaning up or when watching is no longer needed.
   */
  async startWatcher({
    graph,
    skipModules = [],
    skipActions = [],
    bufferInterval,
  }: {
    graph: ConfigGraph
    skipModules?: GardenModule[]
    skipActions?: Action[]
    bufferInterval?: number
  }) {
    const actions = graph.getActions()
    const linkedPaths = (await getLinkedSources(this)).map((s) => s.path)
    const paths = [this.projectRoot, ...linkedPaths]

    // For skipped modules/actions (e.g. those with services in sync mode), we skip watching all files and folders in the
    // module/action root except for the config path. This way, we can still react to changes in config files.
    const skipDirectories = uniq([...skipModules.map((m) => m.path), ...skipActions.map((a) => a.basePath())])
    const configPaths = new Set(
      [...skipModules.map((m) => m.configPath), ...skipActions.map((a) => a.configPath())].filter(Boolean)
    )

    const skipPaths = flatten(
      await Bluebird.map(skipDirectories, async (path: string) => {
        return (await readdir(path))
          .map((relPath) => resolve(path, relPath))
          .filter((absPath) => configPaths.has(absPath))
      })
    )
    this.watcher = new Watcher({
      garden: this,
      log: this.log,
      paths,
      actions,
      skipPaths,
      bufferInterval,
    })
  }

  async getRegisteredPlugins(): Promise<GardenPlugin[]> {
    return Bluebird.map(this.registeredPlugins, (p) => loadPlugin(this.log, this.projectRoot, p))
  }

  @pMemoizeDecorator()
  async getPlugin(pluginName: string): Promise<GardenPlugin> {
    const plugins = await this.getAllPlugins()
    const plugin = findByName(plugins, pluginName)

    if (!plugin) {
      const availablePlugins = getNames(plugins)
      throw new PluginError(
        `Could not find plugin '${pluginName}'. Are you missing a provider configuration? ` +
          `Currently configured plugins: ${availablePlugins.join(", ")}`,
        {
          pluginName,
          availablePlugins,
        }
      )
    }

    return plugin
  }

  /**
   * Returns all registered plugins, loading them if necessary.
   */
  @pMemoizeDecorator()
  async getAllPlugins() {
    // The duplicated check is a small optimization to avoid the async lock when possible,
    // since this is called quite frequently.
    if (this.loadedPlugins) {
      return this.loadedPlugins
    }

    await this.asyncLock.acquire("load-plugins", async () => {
      // This check is necessary since we could in theory have two calls waiting for the lock at the same time.
      if (this.loadedPlugins) {
        return
      }

      this.log.silly(`Loading plugins`)
      const rawConfigs = this.getRawProviderConfigs()

      this.loadedPlugins = await loadAndResolvePlugins(this.log, this.projectRoot, this.registeredPlugins, rawConfigs)

      this.log.silly(`Loaded plugins: ${rawConfigs.map((c) => c.name).join(", ")}`)
    })

    return this.loadedPlugins
  }

  /**
   * Returns plugins that are currently configured in provider configs.
   */
  @pMemoizeDecorator()
  async getConfiguredPlugins() {
    const plugins = await this.getAllPlugins()
    const configNames = keyBy(this.getRawProviderConfigs(), "name")
    return plugins.filter((p) => configNames[p.name])
  }

  /**
   * Returns a mapping of all configured module types in the project and their definitions.
   */
  @pMemoizeDecorator()
  async getModuleTypes(): Promise<ModuleTypeMap> {
    const configuredPlugins = await this.getConfiguredPlugins()
    return getModuleTypes(configuredPlugins)
  }

  /**
   * Returns a mapping of all configured action types in the project and their definitions.
   */
  @pMemoizeDecorator()
  async getActionTypes(): Promise<ActionDefinitionMap> {
    const configuredPlugins = await this.getConfiguredPlugins()
    return getActionTypes(configuredPlugins)
  }

  /**
   * Get the bases for the given action kind/type, with schemas modified to allow any unknown fields.
   * Used to validate actions whose types inherit from others.
   *
   * Implemented here so that we can cache the modified schemas.
   */
  async getActionTypeBases(kind: ActionKind, type: string) {
    const definitions = await this.getActionTypes()

    if (this.actionTypeBases[kind][type]) {
      return this.actionTypeBases[kind][type] || []
    }

    const bases = getActionTypeBases(definitions[kind][type].spec, definitions[kind])
    this.actionTypeBases[kind][type] = bases.map((b) => ({ ...b, schema: allowUnknown(b.schema) }))
    return this.actionTypeBases[kind][type] || []
  }

  getRawProviderConfigs(names?: string[]) {
    return names ? findByNames(names, this.providerConfigs, "provider") : this.providerConfigs
  }

  async resolveProvider(log: Log, name: string) {
    if (name === "_default") {
      return defaultProvider
    }

    if (this.resolvedProviders[name]) {
      return cloneDeep(this.resolvedProviders[name])
    }

    this.log.silly(`Resolving provider ${name}`)

    const providers = await this.resolveProviders(log, false, [name])
    const provider = providers[name]

    if (!provider) {
      const providerNames = Object.keys(providers)
      throw new PluginError(
        `Could not find provider '${name}' in environment '${this.environmentName}' ` +
          `(configured providers: ${providerNames.join(", ") || "<none>"})`,
        {
          name,
          providers,
        }
      )
    }

    return provider
  }

  async resolveProviders(log: Log, forceInit = false, names?: string[]): Promise<ProviderMap> {
    // TODO-G2: split this out of the Garden class
    let providers: Provider[] = []

    await this.asyncLock.acquire("resolve-providers", async () => {
      const rawConfigs = this.getRawProviderConfigs(names)

      if (!names) {
        names = getNames(rawConfigs)
      }

      throwOnMissingSecretKeys(rawConfigs, this.secrets, "Provider", log)

      // As an optimization, we return immediately if all requested providers are already resolved
      const alreadyResolvedProviders = names.map((name) => this.resolvedProviders[name]).filter(Boolean)
      if (alreadyResolvedProviders.length === names.length) {
        providers = cloneDeep(alreadyResolvedProviders)
        return
      }

      log.silly(`Resolving providers`)

      const providerLog = log.createLog({ name: "providers", showDuration: true })
      providerLog.info("Getting status...")

      const plugins = keyBy(await this.getAllPlugins(), "name")

      // Detect circular dependencies here
      const validationGraph = new DependencyGraph()

      await Bluebird.map(rawConfigs, async (config) => {
        const plugin = plugins[config.name]

        if (!plugin) {
          throw new ConfigurationError(`Configured provider '${config.name}' has not been registered.`, {
            name: config.name,
            availablePlugins: Object.keys(plugins),
          })
        }

        validationGraph.addNode(plugin.name)

        for (const dep of await getAllProviderDependencyNames(plugin!, config!)) {
          validationGraph.addNode(dep)
          validationGraph.addDependency(plugin.name, dep)
        }
      })

      const cycles = validationGraph.detectCircularDependencies()

      if (cycles.length > 0) {
        const description = validationGraph.cyclesToString(cycles)
        throw new PluginError(
          `One or more circular dependencies found between providers or their configurations:\n\n${description}`,
          { "circular-dependencies": description }
        )
      }

      const tasks = rawConfigs.map((config) => {
        const plugin = plugins[config.name]

        return new ResolveProviderTask({
          garden: this,
          log: providerLog,
          plugin,
          config,
          force: false,
          forceRefresh: this.forceRefresh,
          forceInit,
          allPlugins: Object.values(plugins),
        })
      })

      // Process as many providers in parallel as possible
      const taskResults = await this.processTasks({ tasks, log })

      const providerResults = Object.values(taskResults.results.getMap())

      const failed = providerResults.filter((r) => r && r.error)

      if (failed.length) {
        const messages = failed.map((r) => `- ${r!.name}: ${r!.error!.message}`)
        const failedNames = failed.map((r) => r!.name)
        throw new PluginError(`Failed resolving one or more providers:\n- ${failedNames.join("\n- ")}`, {
          rawConfigs,
          taskResults,
          messages,
        })
      }

      providers = providerResults.map((result) => result!.result)

      const gotCachedResult = !!providers.find((p) => p.status.cached)

      await Bluebird.map(providers, async (provider) =>
        Bluebird.map(provider.moduleConfigs, async (moduleConfig) => {
          // Make sure module and all nested entities are scoped to the plugin
          moduleConfig.plugin = provider.name
          return this.addModuleConfig(moduleConfig)
        })
      )

      for (const provider of providers) {
        this.resolvedProviders[provider.name] = provider
      }

      if (gotCachedResult) {
        providerLog.success("Cached")
        providerLog.info(chalk.gray("Run with --force-refresh to force a refresh of provider statuses."))
      } else {
        providerLog.success("Done")
      }

      providerLog.silly(`Resolved providers: ${providers.map((p) => p.name).join(", ")}`)
    })

    return keyBy(providers, "name")
  }

  @pMemoizeDecorator()
  async getTools() {
    if (!this.tools) {
      const plugins = await this.getAllPlugins()
      const tools: PluginTools = {}

      for (const plugin of Object.values(plugins)) {
        for (const tool of plugin.tools || []) {
          tools[`${plugin.name}.${tool.name}`] = new PluginTool(tool)
        }
      }

      this.tools = tools
    }
    return this.tools
  }

  /**
   * When running workflows via the `run-workflow` command, we only resolve the workflow being executed.
   */
  async getWorkflowConfig(name: string): Promise<WorkflowConfig> {
    return resolveWorkflowConfig(this, await this.getRawWorkflowConfig(name))
  }

  async getRawWorkflowConfig(name: string): Promise<WorkflowConfig> {
    return (await this.getRawWorkflowConfigs([name]))[0]
  }

  async getRawWorkflowConfigs(names?: string[]): Promise<WorkflowConfig[]> {
    if (!this.configsScanned) {
      await this.scanAndAddConfigs()
    }
    if (names) {
      return Object.values(pickKeys(this.workflowConfigs, names, "workflow"))
    } else {
      return Object.values(this.workflowConfigs)
    }
  }

  /**
   * Returns the reported status from all configured providers.
   */
  async getEnvironmentStatus(log: Log) {
    const providers = await this.resolveProviders(log)
    return mapValues(providers, (p) => p.status)
  }

  @pMemoizeDecorator()
  async getActionRouter() {
    const loadedPlugins = await this.getAllPlugins()
    const moduleTypes = await this.getModuleTypes()
    const plugins = keyBy(loadedPlugins, "name")

    // We only pass configured plugins to the router (others won't have the required configuration to call handlers)
    const configuredPlugins = this.getRawProviderConfigs().map((c) => plugins[c.name])

    return new ActionRouter(this, configuredPlugins, loadedPlugins, moduleTypes)
  }

  /**
   * Returns module configs that are registered in this context, before template resolution and validation.
   * Scans for modules in the project root and remote/linked sources if it hasn't already been done.
   */
  async getRawModuleConfigs(keys?: string[]): Promise<ModuleConfig[]> {
    if (!this.configsScanned) {
      await this.scanAndAddConfigs()
    }

    return Object.values(keys ? pickKeys(this.moduleConfigs, keys, "module config") : this.moduleConfigs)
  }

  /**
   * Returns action configs that are registered in this context, before template resolution and validation.
   * Scans for configs in the project root and remote/linked sources if it hasn't already been done.
   */
  async getRawActionConfigs() {
    if (!this.configsScanned) {
      await this.scanAndAddConfigs()
    }

    return this.actionConfigs
  }

  async getOutputConfigContext(log: Log, modules: GardenModule[], graphResults: GraphResults) {
    const providers = await this.resolveProviders(log)
    return new OutputConfigContext({
      garden: this,
      resolvedProviders: providers,
      variables: this.variables,
      modules,
      graphResults,
      partialRuntimeResolution: false,
    })
  }

  /**
   * Resolve the raw module and action configs and return a new instance of ConfigGraph.
   * The graph instance is immutable and represents the configuration at the point of calling this method.
   * For long-running processes, you need to call this again when any module or configuration has been updated.
   *
   * If `emit = true` is passed, a `stackGraph` event with a rendered DAG representation of the graph will be emitted.
   * When implementing a new command that calls this method and also streams events, make sure that the first
   * call to `getConfigGraph` in the command uses `emit = true` to ensure that the graph event gets streamed.
   */
  async getConfigGraph({ log, graphResults, emit, actionModes = {} }: GetConfigGraphParams): Promise<ConfigGraph> {
    // TODO-G2: split this out of the Garden class
    await this.scanAndAddConfigs()

    const resolvedProviders = await this.resolveProviders(log)
    const rawModuleConfigs = await this.getRawModuleConfigs()

    const graphLog = log.createLog({ name: "graph", showDuration: true }).info(`Resolving actions and modules...`)

    // Resolve the project module configs
    const resolver = new ModuleResolver({
      garden: this,
      log: graphLog,
      rawConfigs: rawModuleConfigs,
      resolvedProviders,
      graphResults,
    })

    const resolvedModules = await resolver.resolveAll()

    // Validate the module dependency structure. This will throw on failure.
    const router = await this.getActionRouter()
    const moduleTypes = await this.getModuleTypes()
    const moduleGraph = new ModuleGraph(resolvedModules, moduleTypes)

    // Require include/exclude on modules if their paths overlap
    const overlaps = detectModuleOverlap({
      projectRoot: this.projectRoot,
      gardenDirPath: this.gardenDirPath,
      moduleConfigs: resolvedModules,
    })
    if (overlaps.length > 0) {
      const { message, detail } = this.makeOverlapError(overlaps)
      throw new ConfigurationError(message, detail)
    }

    // Convert modules to actions
    const { groups: moduleGroups, actions: moduleActionConfigs } = await convertModules(
      this,
      graphLog,
      resolvedModules,
      moduleGraph
    )

    // Get action configs
    const actionConfigs: ActionConfigsByKey = {}

    for (const kind of actionKinds) {
      for (const name in this.actionConfigs[kind]) {
        const key = actionReferenceToString({ kind, name })
        actionConfigs[key] = this.actionConfigs[kind][name]
      }
    }

    for (const config of moduleActionConfigs) {
      const key = actionReferenceToString(config)
      const existing = actionConfigs[key]

      if (existing) {
        const moduleActionPath = config.internal.configFilePath || config.internal.basePath
        const actionPath = existing.internal.configFilePath || existing.internal.basePath
        throw new ConfigurationError(
          `${existing.kind} action '${existing.name}' (in ${actionPath}) conflicts with ${config.kind} action with same name generated from Module ${config.internal?.moduleName} (in ${moduleActionPath}). Please rename either one.`,
          { configFromModule: config, actionConfig: existing }
        )
      }

      actionConfigs[key] = config
    }

    // Resolve configs to Actions
    const graph = await actionConfigsToGraph({
      garden: this,
      configs: Object.values(actionConfigs),
      groupConfigs: moduleGroups,
      log: graphLog,
      moduleGraph,
      actionModes,
    })

    // TODO-G2: detect overlap on Build actions

    // Walk through all plugins in dependency order, and allow them to augment the graph
    const plugins = keyBy(await this.getAllPlugins(), "name")

    for (const pluginName of getDependencyOrder(plugins)) {
      const provider = resolvedProviders[pluginName]

      if (!provider) {
        continue
      }

      // Skip the routine if the provider doesn't have the handler
      const handler = await router.provider.getPluginHandler({
        handlerType: "augmentGraph",
        pluginName,
        throwIfMissing: false,
      })

      if (!handler) {
        continue
      }

      const { addDependencies, addActions } = await router.provider.augmentGraph({
        pluginName,
        log: graphLog,
        providers: resolvedProviders,
        actions: graph.getActions(),
        events: undefined,
      })

      let updated = false

      // TODO-G2: review and add tests
      // Resolve modules from specs and add to the list
      await Bluebird.map(addActions || [], async (config) => {
        // There is no actual config file for plugin modules (which the prepare function assumes)
        delete config.internal?.configFilePath

        if (!config.internal.basePath) {
          config.internal.basePath = this.projectRoot
        }

        const key = actionReferenceToString(config)

        const action = await actionFromConfig({
          garden: this,
          graph,
          config,
          router,
          log: graphLog,
          configsByKey: actionConfigs,
          mode: actionModes[key] || "default",
        })

        graph.addAction(action)
        actionConfigs[key] = config

        updated = true
      })

      for (const dependency of addDependencies || []) {
        for (const key of ["by", "on"]) {
          try {
            graph.getActionByRef(dependency[key])
          } catch (err) {
            throw new PluginError(
              deline`
                Provider '${provider.name}' added a dependency by action '${actionReferenceToString(
                dependency.by
              )}' on '${actionReferenceToString(dependency.on)}'
                but action '${actionReferenceToString(dependency[key])}' could not be found.
              `,
              { provider, dependency }
            )
          }
        }

        graph.addDependency(dependency.by, dependency.on, {
          explicit: true,
          needsStaticOutputs: false,
          needsExecutedOutputs: false,
        })
        updated = true
      }

      if (updated) {
        graph.validate()
      }
    }

    // Ensure dependency structure is alright
    graph.validate()

    if (emit) {
      this.events.emit("stackGraph", graph.render())
    }

    graphLog.success(chalk.green("Done"))

    return graph.toConfigGraph()
  }

  async getResolvedConfigGraph(params: GetConfigGraphParams): Promise<ResolvedConfigGraph> {
    const graph = await this.getConfigGraph(params)
    const resolved = await this.resolveActions({ graph, actions: graph.getActions(), log: params.log })
    return new ResolvedConfigGraph({
      actions: Object.values(resolved),
      moduleGraph: graph.moduleGraph,
      // TODO-G2: perhaps this should be resolved here
      groups: graph.getGroups(),
    })
  }

  async resolveAction<T extends Action>({ action, graph, log }: { action: T; log: Log; graph?: ConfigGraph }) {
    if (!graph) {
      graph = await this.getConfigGraph({ log, emit: false })
    }

    return resolveAction({ garden: this, action, graph, log })
  }

  async resolveActions<T extends Action>({ actions, graph, log }: { actions: T[]; log: Log; graph?: ConfigGraph }) {
    if (!graph) {
      graph = await this.getConfigGraph({ log, emit: false })
    }

    return resolveActions({ garden: this, actions, graph, log })
  }

  async executeAction<T extends Action>({
    action,
    graph,
    log,
    force,
  }: {
    action: T
    log: Log
    graph?: ConfigGraph
    force: boolean
  }) {
    if (!graph) {
      graph = await this.getConfigGraph({ log, emit: false })
    }

    return executeAction({ garden: this, action, graph, log, force })
  }

  /**
   * Resolves the module version (i.e. build version) for the given module configuration and its build dependencies.
   */
  async resolveModuleVersion(
    log: Log,
    moduleConfig: ModuleConfig,
    moduleDependencies: GardenModule[],
    force = false
  ): Promise<ModuleVersion> {
    const moduleName = moduleConfig.name
    const depModuleNames = moduleDependencies.map((m) => m.name)
    depModuleNames.sort()
    const cacheKey = ["moduleVersions", moduleName, ...depModuleNames]

    if (!force) {
      const cached = <ModuleVersion>this.cache.get(log, cacheKey)

      if (cached) {
        return cached
      }
    }

    this.log.silly(`Resolving version for module ${moduleName}`)

    const cacheContexts = [...moduleDependencies, moduleConfig].map((c: ModuleConfig) => getModuleCacheContext(c))

    const treeVersion = await this.vcs.getTreeVersion(this.log, this.projectName, moduleConfig)

    validateSchema(treeVersion, treeVersionSchema(), {
      context: `${this.vcs.name} tree version for module at ${moduleConfig.path}`,
    })

    const namedDependencyVersions = moduleDependencies.map((m) => ({ ...m.version, name: m.name }))

    const versionString = getModuleVersionString(
      moduleConfig,
      { ...treeVersion, name: moduleConfig.name },
      namedDependencyVersions
    )

    const version: ModuleVersion = {
      dependencyVersions: mapValues(keyBy(namedDependencyVersions, "name"), (v) => v.versionString),
      versionString,
      files: treeVersion.files,
    }

    this.cache.set(log, cacheKey, version, ...cacheContexts)
    return version
  }

  /**
   * Scans the specified directories for Garden config files and returns a list of paths.
   */
  async scanForConfigs(path: string) {
    this.log.silly(`Scanning for configs in ${path}`)

    return findConfigPathsInPath({
      vcs: this.vcs,
      dir: path,
      include: this.moduleIncludePatterns,
      exclude: this.moduleExcludePatterns,
      log: this.log,
    })
  }

  /*
    Scans the project root for modules and workflows and adds them to the context.
   */
  async scanAndAddConfigs(force = false) {
    if (this.configsScanned && !force) {
      return
    }

    return this.asyncLock.acquire("scan-configs", async () => {
      if (this.configsScanned && !force) {
        return
      }

      this.log.silly(`Scanning for configs`)

      // Add external sources that are defined at the project level. External sources are either kept in
      // the .garden/sources dir (and cloned there if needed), or they're linked to a local path via the link command.
      const linkedSources = await getLinkedSources(this, "project")
      const projectSources = this.getProjectSources()
      const extSourcePaths = await Bluebird.map(projectSources, ({ name, repositoryUrl }) => {
        return this.loadExtSourcePath({
          name,
          linkedSources,
          repositoryUrl,
          sourceType: "project",
        })
      })

      const dirsToScan = [this.projectRoot, ...extSourcePaths]
      const configPaths = flatten(await Bluebird.map(dirsToScan, (path) => this.scanForConfigs(path)))

      const allResources = flatten(
        await Bluebird.map(configPaths, async (path) => (await this.loadResources(path)) || [])
      )
      const groupedResources = groupBy(allResources, "kind")

      for (const [kind, configs] of Object.entries(groupedResources)) {
        throwOnMissingSecretKeys(configs, this.secrets, kind, this.log)
      }

      let rawModuleConfigs = [...((groupedResources.Module as ModuleConfig[]) || [])]
      const rawWorkflowConfigs = (groupedResources.Workflow as WorkflowConfig[]) || []
      const rawConfigTemplateResources = (groupedResources[configTemplateKind] as ConfigTemplateResource[]) || []

      // Resolve config templates
      const configTemplates = await Bluebird.map(rawConfigTemplateResources, (r) => resolveConfigTemplate(this, r))
      const templatesByName = keyBy(configTemplates, "name")
      // -> detect duplicate templates
      const duplicateTemplates = duplicatesByKey(configTemplates, "name")

      if (duplicateTemplates.length > 0) {
        const messages = duplicateTemplates
          .map(
            (d) =>
              `Name ${d.value} is used at ${naturalList(
                d.duplicateItems.map((i) =>
                  relative(this.projectRoot, i.internal.configFilePath || i.internal.basePath)
                )
              )}`
          )
          .join("\n")
        throw new ConfigurationError(`Found duplicate names of ${configTemplateKind}s:\n${messages}`, {
          duplicateTemplates,
        })
      }

      // Convert type:templated modules to Render configs
      // TODO: remove in 0.14
      const rawTemplatedModules = rawModuleConfigs.filter((m) => m.type === "templated") as TemplatedModuleConfig[]
      // -> removed templated modules from the module config list
      rawModuleConfigs = rawModuleConfigs.filter((m) => m.type !== "templated")

      const renderConfigs = [
        ...(groupedResources[renderTemplateKind] || []),
        ...rawTemplatedModules.map(convertTemplatedModuleToRender),
      ] as RenderTemplateConfig[]

      // Resolve Render configs
      const renderResults = await Bluebird.map(renderConfigs, (config) =>
        renderConfigTemplate({ garden: this, log: this.log, config, templates: templatesByName })
      )
      const actionsFromTemplates = renderResults.flatMap((r) => r.configs.filter(isActionConfig))
      const modulesFromTemplates = renderResults.flatMap((r) => r.modules)
      const workflowsFromTemplates = renderResults.flatMap((r) => r.configs.filter(isWorkflowConfig))

      if (renderConfigs.length) {
        this.log.silly(
          `Rendered ${actionsFromTemplates.length} actions, ${modulesFromTemplates.length} modules, and ${workflowsFromTemplates.length} workflows from templates`
        )
      }

      rawModuleConfigs.push(...modulesFromTemplates)
      rawWorkflowConfigs.push(...workflowsFromTemplates)

      // Add all the configs
      rawModuleConfigs.map((c) => this.addModuleConfig(c))
      rawWorkflowConfigs.map((c) => this.addWorkflow(c))

      let actionsCount = 0

      for (const kind of actionKinds) {
        for (const config of groupedResources[kind] || []) {
          this.addActionConfig(config as unknown as BaseActionConfig)
          actionsCount++
        }
      }

      for (const config of actionsFromTemplates) {
        this.addActionConfig(config)
      }

      this.log.debug(
        `Scanned and found ${actionsCount} actions, ${rawWorkflowConfigs.length} workflows and ${rawModuleConfigs.length} modules`
      )

      this.configsScanned = true
      this.configTemplates = { ...this.configTemplates, ...keyBy(configTemplates, "name") }
    })
  }

  /**
   * Add an action config to the context, after validating and calling the appropriate configure plugin handler.
   */
  protected addActionConfig(config: BaseActionConfig) {
    this.log.silly(`Adding ${config.kind} action ${config.name}`)
    const existing = this.actionConfigs[config.kind][config.name]

    if (existing) {
      const paths = [
        existing.internal.configFilePath || existing.internal.basePath,
        config.internal.configFilePath || config.internal.basePath,
      ]
      const [pathA, pathB] = paths.map((path) => relative(this.projectRoot, path)).sort()

      throw new ConfigurationError(
        `${config.kind} action ${config.name} is declared multiple times (in '${pathA}' and '${pathB}')`,
        {
          pathA,
          pathB,
        }
      )
    }

    this.actionConfigs[config.kind][config.name] = config
  }

  /**
   * Add a module config to the context, after validating and calling the appropriate configure plugin handler.
   */
  private addModuleConfig(config: ModuleConfig) {
    const key = config.name
    this.log.silly(`Adding module ${key}`)
    const existing = this.moduleConfigs[key]

    if (existing) {
      const paths = [existing.configPath || existing.path, config.configPath || config.path]
      const [pathA, pathB] = paths.map((path) => relative(this.projectRoot, path)).sort()

      throw new ConfigurationError(`Module ${key} is declared multiple times (in '${pathA}' and '${pathB}')`, {
        pathA,
        pathB,
      })
    }

    this.moduleConfigs[key] = config
  }

  /**
   * Add a workflow config to the context after validating that its name doesn't conflict with previously
   * added workflows, and partially resolving it (i.e. without fully resolving step configs, which
   * is done just-in-time before a given step is run).
   */
  private addWorkflow(config: WorkflowConfig) {
    const key = config.name
    this.log.silly(`Adding workflow ${key}`)

    const existing = this.workflowConfigs[key]

    if (existing) {
      const paths = [existing.internal.configFilePath || existing.internal.basePath, config.internal.basePath]
      const [pathA, pathB] = paths.map((path) => relative(this.projectRoot, path)).sort()

      throw new ConfigurationError(`Workflow ${key} is declared multiple times (in '${pathA}' and '${pathB}')`, {
        pathA,
        pathB,
      })
    }

    this.workflowConfigs[key] = config
  }

  /**
   * Load any non-Project resources from the specified config file path.
   *
   * @param configPath Path to a garden config file
   */
  private async loadResources(configPath: string): Promise<(GardenResource | ModuleConfig)[]> {
    configPath = resolve(this.projectRoot, configPath)
    this.log.silly(`Load configs from ${configPath}`)
    const resources = await loadConfigResources(this.log, this.projectRoot, configPath)
    this.log.silly(`Loaded configs from ${configPath}`)
    return resources.filter((r) => r.kind && r.kind !== "Project")
  }

  //===========================================================================
  //region Internal helpers
  //===========================================================================

  /**
   * Returns the configured project sources, and resolves any template strings on them.
   */
  public getProjectSources() {
    const context = new RemoteSourceConfigContext(this, this.variables)
    const resolved = validateSchema(resolveTemplateStrings(this.projectSources, context), projectSourcesSchema(), {
      context: "remote source",
    })
    return resolved
  }

  /**
   * Clones the project/module source if needed and returns the path (either from .garden/sources or from a local path)
   */
  public async loadExtSourcePath({
    name,
    linkedSources,
    repositoryUrl,
    sourceType,
  }: {
    name: string
    linkedSources: LinkedSource[]
    repositoryUrl: string
    sourceType: ExternalSourceType
  }): Promise<string> {
    const linked = findByName(linkedSources, name)

    if (linked) {
      return linked.path
    }

    const path = await this.vcs.ensureRemoteSource({
      name,
      sourceType,
      url: repositoryUrl,
      log: this.log,
    })

    return path
  }

  public makeOverlapError(moduleOverlaps: ModuleOverlap[]) {
    const overlapList = sortBy(moduleOverlaps, (o) => o.module.name)
      .map(({ module, overlaps }) => {
        const formatted = overlaps.map((o) => {
          const detail = o.path === module.path ? "same path" : "nested"
          return `${chalk.bold(o.name)} (${detail})`
        })
        return `Module ${chalk.bold(module.name)} overlaps with module(s) ${naturalList(formatted)}.`
      })
      .join("\n\n")
    const message = chalk.red(dedent`
      Found multiple enabled modules that share the same garden.yml file or are nested within another:

      ${overlapList}

      If this was intentional, there are two options to resolve this error:

      - You can add ${chalk.bold("include")} and/or ${chalk.bold("exclude")} directives on the affected modules.
        With explicitly including / encluding files, the modules are actually allowed to overlap in case that is
        what you want.
      - You can use the ${chalk.bold("disabled")} directive to make sure that only one of the modules is enabled
        in any given moment. For example, you can make sure that the modules are enabled only in their exclusive
        environment.
    `)
    // Sanitize error details
    const overlappingModules = moduleOverlaps.map(({ module, overlaps }) => {
      return {
        module: { name: module.name, path: resolve(this.projectRoot, module.path) },
        overlaps: overlaps.map(({ name, path }) => ({ name, path: resolve(this.projectRoot, path) })),
      }
    })
    return { message, detail: { overlappingModules } }
  }

  /**
   * This dumps the full project configuration including all modules.
   * Set includeDisabled=true to include disabled modules, services, tasks and tests.
   * Set partial=true to avoid resolving providers. If set, includeDisabled is implicitly true.
   */
  public async dumpConfig({
    log,
    includeDisabled = false,
    partial = false,
  }: {
    log: Log
    includeDisabled?: boolean
    partial?: boolean
  }): Promise<ConfigDump> {
    let providers: ConfigDump["providers"] = []
    let moduleConfigs: ModuleConfig[]
    let workflowConfigs: WorkflowConfig[]
    let actionConfigs: ActionConfigMap = {
      Build: {},
      Deploy: {},
      Run: {},
      Test: {},
    }

    await this.scanAndAddConfigs()

    if (partial) {
      providers = this.getRawProviderConfigs()
      moduleConfigs = await this.getRawModuleConfigs()
      workflowConfigs = await this.getRawWorkflowConfigs()
      actionConfigs = this.actionConfigs
    } else {
      const graph = await this.getResolvedConfigGraph({ log, emit: false })

      for (const action of graph.getActions()) {
        actionConfigs[action.kind][action.name] = action.getConfig()
      }

      const modules = graph.getModules({ includeDisabled })
      moduleConfigs = sortBy(
        modules.map((m) => m._config),
        "name"
      )

      workflowConfigs = (await this.getRawWorkflowConfigs()).map((config) => resolveWorkflowConfig(this, config))

      providers = Object.values(await this.resolveProviders(log))
    }

    const allEnvironmentNames = this.environmentConfigs.map((c) => c.name)

    return {
      environmentName: this.environmentName,
      allEnvironmentNames,
      namespace: this.namespace,
      providers,
      variables: this.variables,
      actionConfigs,
      moduleConfigs,
      workflowConfigs: sortBy(workflowConfigs, "name"),
      projectName: this.projectName,
      projectRoot: this.projectRoot,
      projectId: this.projectId,
      domain: this.cloudDomain,
      sources: this.projectSources,
    }
  }

  /** Returns whether the user is logged in to the Garden Cloud */
  public isLoggedIn(): boolean {
    return !!this.cloudApi
  }
}

export const resolveGardenParams = profileAsync(async function _resolveGardenParams(
  currentDirectory: string,
  opts: GardenOpts
): Promise<GardenParams> {
  let { environmentName: environmentStr, config, gardenDirPath, plugins = [], disablePortForwards } = opts
  const log = opts.log || getLogger().createLog()

  if (!config) {
    config = await findProjectConfig(log, currentDirectory)

    if (!config) {
      throw new ConfigurationError(`Not a project directory (or any of the parent directories): ${currentDirectory}`, {
        currentDirectory,
      })
    }
  }

  gardenDirPath = resolve(config.path, gardenDirPath || DEFAULT_GARDEN_DIR_NAME)
  await ensureDir(gardenDirPath)

  const artifactsPath = resolve(gardenDirPath, "artifacts")
  await ensureDir(artifactsPath)

  const _username = (await username()) || ""
  const projectName = config.name

  const { sources: projectSources, path: projectRoot } = config
  const commandInfo = opts.commandInfo

  const treeCache = new TreeCache()

  // Note: another VcsHandler is created later, this one is temporary
  const gitHandler = new GitHandler({
    projectRoot,
    gardenDirPath,
    ignoreFile: defaultConfigFilename,
    cache: treeCache,
  })
  const vcsInfo = await gitHandler.getPathInfo(log, projectRoot)

  // Since we iterate/traverse them before fully validating them (which we do after resolving template strings), we
  // validate that `config.environments` and `config.providers` are both arrays.
  // This prevents cryptic type errors when the user mistakely writes down e.g. a map instead of an array.
  validateWithPath({
    config: config.environments,
    schema: joi.array().items(joi.object()).min(1).required(),
    configType: "project environments",
    path: config.path,
    projectRoot: config.path,
  })

  const localConfigStore = new LocalConfigStore(gardenDirPath)
  const localConfigDefaultEnv = await localConfigStore.get("defaultEnv")

  if (localConfigDefaultEnv) {
    log.debug(`Using environment ${localConfigDefaultEnv}, set with the \`set default-env\` command`)
  }

  const defaultEnvironmentName =
    localConfigDefaultEnv ||
    (resolveTemplateString(
      config.defaultEnvironment,
      new DefaultEnvironmentContext({
        projectName,
        projectRoot,
        artifactsPath,
        vcsInfo,
        username: _username,
        commandInfo,
      })
    ) as string)

  const defaultEnvironment = getDefaultEnvironmentName(defaultEnvironmentName, config)

  if (!environmentStr) {
    environmentStr = defaultEnvironment
  }

  const { environment: environmentName } = parseEnvironment(environmentStr)

  const sessionId = opts.sessionId || uuidv4()

  let secrets: StringMap = {}
  const cloudApi = opts.cloudApi || null
  // fall back to get the domain from config if the cloudApi instance failed
  // to login or was not defined.
  const cloudDomain = cloudApi?.domain || getGardenCloudDomain(config.domain)

  // The cloudApi instance only has a project ID when the configured ID has
  // been verified against the cloud instance.
  let cloudProjectId: string | undefined = config.id

  if (!opts.noEnterprise && cloudApi) {
    const distroName = getCloudDistributionName(cloudDomain || "")
    const section = getCloudLogSectionName(distroName)
    const cloudLog = log.createLog({ section, showDuration: true })
    cloudLog.info(`Initializing ${distroName}...`)

    let project: CloudProject | undefined

    if (cloudProjectId) {
      // Ensure that the current projectId exists in the remote project
      try {
        project = await cloudApi.verifyAndConfigureProject(cloudProjectId)
      } catch (err) {
        cloudLog.debug(`Getting project from API failed with error: ${err.message}`)
      }
    }

    if (!project && !cloudProjectId && !config.domain) {
      // Create a new project in case the project does not exist
      // and the user is logged in to a default domain.
      // Note: excluding projects with a domain is for backwards compatibility
      cloudLog.debug(`Creating or retrieving a ${distroName} project called ${projectName}.`)

      try {
        project = await cloudApi.getOrCreateProject(projectName)
      } catch (err) {
        if (err instanceof CloudApiDuplicateProjectsError) {
          cloudLog.warn(chalk.yellow(wordWrap(err.message, 120)))
        } else {
          cloudLog.debug(`Creating a new cloud project failed with error: ${err.message}`)
        }
      }
    }

    if (project) {
      if (cloudApi.projectId) {
        // ensure we use the fetched/created project ID
        cloudProjectId = cloudApi.projectId

        // Only fetch secrets if the projectId exists in the cloud API instance
        try {
          secrets = await getSecrets({ log: cloudLog, projectId: cloudApi.projectId, environmentName, cloudApi })
          cloudLog.success(chalk.green("Ready"))
          cloudLog.silly(`Fetched ${Object.keys(secrets).length} secrets from ${cloudDomain}`)
        } catch (err) {
          cloudLog.debug(`Fetching secrets failed with error: ${err.message}`)
        }
      }
    } else {
      cloudLog.info(
        chalk.yellow(
          wordWrap(
            deline`Logged in to ${cloudDomain}, but could not find the project '${projectName}'.
            Command results for this command run will not be available in ${distroName}.`,
            120
          )
        )
      )
    }
  }

  const loggedIn = !!cloudApi

  config = resolveProjectConfig({
    defaultName: defaultEnvironmentName,
    config,
    artifactsPath,
    vcsInfo,
    username: _username,
    loggedIn,
    enterpriseDomain: cloudDomain,
    secrets,
    commandInfo,
  })

  let { namespace, providers, variables, production } = await pickEnvironment({
    projectConfig: config,
    envString: environmentStr,
    artifactsPath,
    vcsInfo,
    username: _username,
    loggedIn,
    enterpriseDomain: cloudDomain,
    secrets,
    commandInfo,
  })

  // Allow overriding variables
  const cliVariables = opts.variables || {}
  variables = { ...variables, ...cliVariables }

  const workingCopyId = await getWorkingCopyId(gardenDirPath)

  // We always exclude the garden dir
  const gardenDirExcludePattern = `${relative(projectRoot, gardenDirPath)}/**/*`
  const moduleExcludePatterns = [
    ...((config.modules || {}).exclude || []),
    gardenDirExcludePattern,
    ...fixedProjectExcludes,
  ]

  // Set proxy hostname with the following order of precedence: env var > config > default value ("localhost")
  let proxyHostname: string
  if (gardenEnv.GARDEN_PROXY_DEFAULT_ADDRESS) {
    proxyHostname = gardenEnv.GARDEN_PROXY_DEFAULT_ADDRESS
  } else if (config.proxy?.hostname) {
    proxyHostname = config.proxy.hostname
  } else {
    proxyHostname = defaultLocalAddress
  }
  const proxy = {
    hostname: proxyHostname,
  }

  return {
    artifactsPath,
    vcsInfo,
    sessionId,
    disablePortForwards,
    projectId: cloudProjectId,
    cloudDomain,
    projectRoot,
    projectName,
    environmentName,
    environmentConfigs: config.environments,
    namespace,
    variables,
    cliVariables,
    secrets,
    projectSources,
    production,
    gardenDirPath,
    globalConfigStore: opts.globalConfigStore,
    localConfigStore,
    opts,
    outputs: config.outputs || [],
    plugins,
    providerConfigs: providers,
    moduleExcludePatterns,
    workingCopyId,
    dotIgnoreFile: config.dotIgnoreFile,
    proxy,
    log,
    moduleIncludePatterns: (config.modules || {}).include,
    username: _username,
    forceRefresh: opts.forceRefresh,
    cloudApi,
    cache: treeCache,
  }
})

/**
 * Dummy Garden class that doesn't scan for modules nor resolves providers.
 * Used by commands that have noProject=true. That is, commands that need
 * to run outside of valid Garden projects.
 */
export class DummyGarden extends Garden {
  async resolveProviders() {
    return {}
  }

  async scanAndAddConfigs() {}

  async getRepoRoot() {
    return ""
  }
}

export interface ConfigDump {
  environmentName: string // TODO: Remove this?
  allEnvironmentNames: string[]
  namespace: string
  providers: (Provider | GenericProviderConfig)[]
  variables: DeepPrimitiveMap
  actionConfigs: ActionConfigMap
  moduleConfigs: ModuleConfig[]
  workflowConfigs: WorkflowConfig[]
  projectName: string
  projectRoot: string
  projectId?: string
  domain?: string
  sources: SourceConfig[]
}

export interface GetConfigGraphParams {
  log: Log
  graphResults?: GraphResults
  emit: boolean
  actionModes?: ActionModeMap
}
