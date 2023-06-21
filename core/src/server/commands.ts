/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import type Joi from "@hapi/joi"
import { getLogLevelChoices, LogLevel } from "../logger/logger"
import stringArgv from "string-argv"
import { Command, CommandParams, CommandResult, ConsoleCommand } from "../commands/base"
import { createSchema, joi } from "../config/common"
import { createActionLog, type Log } from "../logger/log-entry"
import { ParameterValues, ChoicesParameter, StringParameter, StringsParameter, GlobalOptions } from "../cli/params"
import { parseCliArgs, pickCommand, processCliArgs } from "../cli/helpers"
import type { AutocompleteSuggestion } from "../cli/autocomplete"
import { naturalList } from "../util/string"
import { isMatch } from "micromatch"
import type { GardenInstanceManager } from "./instance-manager"
import { deepFilter } from "../util/objects"
import { isDirectory } from "../util/fs"
import { pathExists } from "fs-extra"
import type { ProjectResource } from "../config/project"
import { findProjectConfig } from "../config/base"
import type { GlobalConfigStore } from "../config-store/global"
import type { ParsedArgs } from "minimist"
import type { ServeCommand } from "../commands/serve"
import { uuidv4 } from "../util/random"
import type { StatusCommandResult } from "../commands/get/get-status"
import type { DeployStatus } from "../plugin/handlers/Deploy/get-status"
import type { GetSyncStatusResult } from "../plugin/handlers/Deploy/get-sync-status"
import { fromPairs, omit } from "lodash"
import { sanitizeValue } from "../util/logging"
import { getSyncStatuses } from "../commands/sync/sync-status"
import Bluebird from "bluebird"
import { ActionRouter } from "../router/router"
import { ResolvedConfigGraph } from "../graph/config-graph"
import { makeActionCompletePayload } from "../events/util"
import { ActionStatusPayload } from "../events/action-status-events"
import { BuildStatusForEventPayload } from "../plugin/handlers/Build/get-status"
import { DeployStatusForEventPayload } from "../types/service"
import { RunStatusForEventPayload } from "../plugin/plugin"

export interface CommandMap {
  [key: string]: {
    command: Command
    requestSchema: Joi.ObjectSchema
    // TODO: implement resultSchema on Commands, so we can include it here as well (for docs mainly)
  }
}

const autocompleteArguments = {
  input: new StringParameter({
    help: "The input string to provide suggestions for.",
    required: true,
  }),
}

type AutocompleteArguments = typeof autocompleteArguments

interface AutocompleteResult {
  input: string
  suggestions: AutocompleteSuggestion[]
}

export class AutocompleteCommand extends ConsoleCommand<AutocompleteArguments> {
  name = "autocomplete"
  help = "Given an input string, provide a list of suggestions for available Garden commands."
  hidden = true

  noProject = true

  arguments = autocompleteArguments

  enableAnalytics = false

  constructor(private manager: GardenInstanceManager) {
    super(manager)
  }

  async action({
    log,
    garden,
    args,
  }: CommandParams<AutocompleteArguments>): Promise<CommandResult<AutocompleteResult>> {
    const { input } = args

    return {
      result: {
        input,
        suggestions: this.manager.getAutocompleteSuggestions({ log, projectRoot: garden.projectRoot, input }),
      },
    }
  }
}

export class ReloadCommand extends ConsoleCommand {
  name = "reload"
  help = "Reload the project and action/module configuration."

  noProject = true

  constructor(private serveCommand?: ServeCommand) {
    super(serveCommand)
  }

  async action({ log }: CommandParams) {
    // No-op except when running serve or dev command
    await this.serveCommand?.reload(log)
    return {}
  }
}

const logLevelArguments = {
  level: new ChoicesParameter({
    choices: getLogLevelChoices(),
    help: "The log level to set",
    required: true,
  }),
}

type LogLevelArguments = typeof logLevelArguments

// These are the only writers for which we want to dynamically update the log level
const displayWriterTypes = ["basic", "ink"]

export class LogLevelCommand extends ConsoleCommand<LogLevelArguments> {
  name = "log-level"
  help = "Change the max log level of (future) printed logs in the console."

  noProject = true

  arguments = logLevelArguments

  async action({ log, commandLine, args }: CommandParams<LogLevelArguments>) {
    const level = args.level

    const logger = log.root

    const writers = logger.getWriters()
    for (const writer of [writers.display, ...writers.file]) {
      if (displayWriterTypes.includes(writer.type)) {
        writer.level = level as unknown as LogLevel
      }
    }

    commandLine?.flashMessage(`Log level set to ${level}`)

    return {}
  }
}

const hideArgs = {
  type: new ChoicesParameter({
    help: "The type of monitor to stop. Skip to stop all monitoring.",
    choices: ["log", "logs", "sync", "syncs", "local", ""],
    defaultValue: "",
  }),
  names: new StringsParameter({
    help: "The name(s) of the deploy(s) to stop monitoring for (skip to stop monitoring all of them). You may specify multiple names, separated by spaces.",
    spread: true,
    getSuggestions: ({ configDump }) => {
      return Object.keys(configDump.actionConfigs.Deploy)
    },
  }),
}

type HideArgs = typeof hideArgs

export class HideCommand extends ConsoleCommand<HideArgs> {
  name = "hide"
  aliases = ["stop"]
  help = "Stop monitoring for logs for all or specified Deploy actions"

  arguments = hideArgs

  async action({ garden, log, args }: CommandParams<HideArgs>) {
    let type = args.type
    const names = !args.names || args.names.length === 0 ? ["*"] : args.names

    // Support plurals as aliases
    if (type === "logs" || type === "syncs") {
      type = type.slice(0, -1)
    }

    log.info("")

    if (!type) {
      log.info("Stopping all monitors...")
    } else if (names.includes("*")) {
      log.info(`Stopping all ${type} monitors...`)
    } else {
      log.info(`Stopping ${type} monitors for Deploy(s) matching ` + naturalList(names, { quote: true }))
    }

    const monitors = garden.monitors.getActive()

    for (const monitor of monitors) {
      if (monitor && (!type || monitor.type === type) && isMatch(monitor.key(), names)) {
        log.info(`Stopping ${monitor.description()}...`)
        garden.monitors.stop(monitor, log)
      }
    }

    log.info("Done!\n")

    return {}
  }
}

interface GetDeployStatusCommandResult {
  actions: {
    [actionName: string]: {
      deployStatus: DeployStatus
      syncStatus: GetSyncStatusResult
    }
  }
}

export class _GetDeployStatusCommand extends ConsoleCommand {
  name = "_get-deploy-status"
  help = "[Internal] Outputs a map of actions with their corresponding deploy and sync statuses."
  hidden = true

  enableAnalytics = false
  streamEvents = false

  outputsSchema = () => joi.object()

  async action({ garden, log }: CommandParams): Promise<CommandResult<GetDeployStatusCommandResult>> {
    const router = await garden.getActionRouter()
    const graph = await garden.getResolvedConfigGraph({ log, emit: true })
    const deployActions = graph.getDeploys({ includeDisabled: false }).sort((a, b) => (a.name > b.name ? 1 : -1))

    const deployStatusesRaw = await router.getDeployStatuses({ log, graph })

    const deployStatuses = Object.entries(deployStatusesRaw).reduce((acc, val) => {
      const [name, status] = val
      const statusWithOutDetail = omit(status, "detail.detail")
      acc[name] = statusWithOutDetail

      return acc
    }, {} as StatusCommandResult["actions"]["Deploy"])

    const commandLog = log.createLog({ fixLevel: LogLevel.silly })
    const syncStatuses = await getSyncStatuses({ garden, graph, deployActions, log: commandLog, skipDetail: true })

    const actions = deployActions.reduce((acc, val) => {
      acc[val.name] = {
        deployStatus: deployStatuses[val.name],
        syncStatus: syncStatuses[val.name],
      }
      return acc
    }, {} as { [key: string]: { deployStatus: DeployStatus; syncStatus: GetSyncStatusResult } })

    const result = { actions }

    const sanitized = sanitizeValue(deepFilter(result, (_, key) => key !== "executedAction"))

    return { result: sanitized }
  }
}

interface GetActionStatusesCommandResult {
  actions: {
    build: Record<string, ActionStatusPayload<BuildStatusForEventPayload>>
    deploy: Record<string, ActionStatusPayload<DeployStatusForEventPayload>>
    run: Record<string, ActionStatusPayload<RunStatusForEventPayload>>
    test: Record<string, ActionStatusPayload<RunStatusForEventPayload>>
  }
}

export class _GetActionStatusesCommand extends ConsoleCommand {
  name = "_get-action-statuses"
  help = "[Internal/Experimental] Retuns a map of all actions statuses."
  hidden = true

  streamEvents = false

  outputsSchema = () => joi.object()

  async action({ garden, log }: CommandParams): Promise<CommandResult<GetActionStatusesCommandResult>> {
    const router = await garden.getActionRouter()
    const graph = await garden.getResolvedConfigGraph({ log, emit: true })

    const actions = await Bluebird.props({
      build: getBuildStatuses(router, graph, log),
      deploy: getDeployStatuses(router, graph, log),
      test: getTestStatuses(router, graph, log),
      run: getRunStatuses(router, graph, log),
    })


    return { result: { actions } }
  }
}

async function getDeployStatuses(router: ActionRouter, graph: ResolvedConfigGraph, log: Log) {
  const actions = graph.getDeploys()

  return fromPairs(
    await Bluebird.map(actions, async (action) => {
      const startedAt = new Date().toISOString()
      const actionLog = createActionLog({ log, actionName: action.name, actionKind: action.kind })
      const { result } = await router.deploy.getStatus({ action, log: actionLog, graph })

      const payload = makeActionCompletePayload({
        result,
        operation: "getStatus",
        startedAt,
        force: false,
        action,
      }) as ActionStatusPayload<DeployStatusForEventPayload>

      return [action.name, payload]
    })
  )
}

async function getBuildStatuses(router: ActionRouter, graph: ResolvedConfigGraph, log: Log) {
  const actions = graph.getBuilds()

  return fromPairs(
    await Bluebird.map(actions, async (action) => {
      const startedAt = new Date().toISOString()
      const actionLog = createActionLog({ log, actionName: action.name, actionKind: action.kind })
      const { result } = await router.build.getStatus({ action, log: actionLog, graph })

      const payload = makeActionCompletePayload({
        result,
        operation: "getStatus",
        startedAt,
        force: false,
        action,
      }) as ActionStatusPayload<BuildStatusForEventPayload>

      return [action.name, payload]
    })
  )
}

async function getTestStatuses(router: ActionRouter, graph: ResolvedConfigGraph, log: Log) {
  const actions = graph.getTests()

  return fromPairs(
    await Bluebird.map(actions, async (action) => {
      const actionLog = createActionLog({ log, actionName: action.name, actionKind: action.kind })
      const startedAt = new Date().toISOString()
      const { result } = await router.test.getResult({ action, log: actionLog, graph })
      const payload = makeActionCompletePayload({
        result,
        operation: "getStatus",
        startedAt,
        force: false,
        action,
      }) as ActionStatusPayload<RunStatusForEventPayload>
      return [action.name, payload]
    })
  )
}

async function getRunStatuses(router: ActionRouter, graph: ResolvedConfigGraph, log: Log) {
  const actions = graph.getRuns()

  return fromPairs(
    await Bluebird.map(actions, async (action) => {
      const actionLog = createActionLog({ log, actionName: action.name, actionKind: action.kind })
      const startedAt = new Date().toISOString()
      const { result } = await router.run.getResult({ action, log: actionLog, graph })

      const payload = makeActionCompletePayload({
        result,
        operation: "getStatus",
        startedAt,
        force: false,
        action,
      }) as ActionStatusPayload<RunStatusForEventPayload>

      return [action.name, payload]
    })
  )
}

export interface BaseServerRequest {
  id?: string
  command?: string
  environment?: string
  projectRoot?: string
  stringArguments?: string[]
  internal?: boolean
}

export const serverRequestSchema = createSchema({
  name: "server-request",
  keys: () => ({
    id: joi.string().uuid().description("A UUID to assign to the request."),
    command: joi
      .string()
      .description("The command to run, along with any arguments, as if passed to the CLI normally.")
      .example("deploy api --force"),
    environment: joi
      .environment()
      .description(
        "Run the command against the specified environment. Otherwise a default is derived from configuration or from the command line of the dev/server process if applicable. If an --env flag is present in the command, that takes precedence."
      ),
    projectRoot: joi
      .string()
      .description(
        "Specify a project root. By default the cwd of the server process is used. Note that if this is set, it must point to a directory that exists, and only that specific directory will be searched (as opposed to scanning parent directories)."
      ),
    stringArguments: joi
      .array()
      .items(joi.string())
      .description(
        "Array of args to append to the given command. Kept for backwards compatibility (it's now enough to just use the command string."
      )
      .meta({ deprecated: true }),
    internal: joi
      .boolean()
      .description(
        "Internal command that's not triggered by the user. Internal commands have a higher log level and results are not persisted in Cloud."
      ),
  }),
})

// TODO: refactor and deduplicate from the GardenCli class
/**
 * Validate and map a request body to a Command
 */
export async function resolveRequest({
  log,
  manager,
  defaultProjectRoot,
  globalConfigStore,
  request,
  inheritedOpts,
}: {
  log: Log
  manager: GardenInstanceManager
  defaultProjectRoot: string
  globalConfigStore: GlobalConfigStore
  request: BaseServerRequest
  inheritedOpts?: Partial<ParameterValues<GlobalOptions>>
}) {
  function fail(code: number, message: string, detail?: string) {
    return { error: { code, message, detail } }
  }

  let projectConfig: ProjectResource | undefined

  // TODO: support --root option flag

  if (request.projectRoot) {
    if (!(await pathExists(request.projectRoot))) {
      return fail(400, `Specified projectRoot path (${request.projectRoot}) does not exist.`)
    } else if (!(await isDirectory(request.projectRoot))) {
      return fail(400, `Specified projectRoot path (${request.projectRoot}) is not a directory.`)
    }

    projectConfig = await findProjectConfig({ log, path: request.projectRoot, allowInvalid: true, scan: false })

    if (!projectConfig) {
      return fail(
        400,
        `Specified projectRoot path (${request.projectRoot}) does not contain a Garden project config (the exact directory of the project root must be specified).`
      )
    }
  } else {
    projectConfig = await findProjectConfig({ log, path: defaultProjectRoot, allowInvalid: true, scan: true })

    if (!projectConfig) {
      return fail(400, `Could not find a Garden project in '${request.projectRoot}' or any parent directory.`)
    }
  }

  const projectRoot = projectConfig.path

  const internal = request.internal

  // Prepare arguments for command action.
  let command: Command | undefined
  let rest: string[] = []
  let argv: ParsedArgs | undefined
  let cmdArgs: ParameterValues<any> = {}
  let cmdOpts: ParameterValues<any> = {}

  if (request.command) {
    const { commands } = await manager.ensureProjectRootContext(log, projectRoot)

    const args = [...stringArgv(request.command.trim()), ...(request.stringArguments || [])]
    const picked = pickCommand(commands, args)
    command = picked.command
    rest = picked.rest

    if (!command) {
      return fail(404, `Could not find command ${request.command}.`)
    }

    // Note that we clone the command here to ensure that each request gets its own
    // command instance and thereby that subscribers are properly isolated at the request level.
    command = command.clone()

    const { matchedPath } = picked

    // Prepare arguments for command action.
    try {
      argv = parseCliArgs({ stringArgs: rest, command, cli: false, skipGlobalDefault: true })

      const parseResults = processCliArgs({
        rawArgs: args,
        parsedArgs: argv,
        matchedPath,
        command,
        cli: false,
        inheritedOpts,
        warnOnGlobalOpts: true,
      })
      cmdArgs = parseResults.args
      cmdOpts = parseResults.opts
    } catch (error) {
      return fail(400, `Invalid arguments for command ${command.getFullName()}`, error.message)
    }
  }

  const serverLogger = command?.getServerLogger() || log.root

  const cmdLog = serverLogger.createLog({})

  const sessionId = request.id || uuidv4()

  const garden = await manager.getGardenForRequest({
    command,
    log: cmdLog,
    projectConfig,
    globalConfigStore,
    args: cmdArgs,
    opts: cmdOpts,
    environmentString: request.environment,
    sessionId,
  })

  cmdLog.context.gardenKey = garden.getInstanceKey()
  cmdLog.context.sessionId = sessionId

  return {
    garden,
    command,
    log: cmdLog,
    argv,
    args: cmdArgs,
    opts: cmdOpts,
    internal,
    rest,
    error: null,
  }
}
