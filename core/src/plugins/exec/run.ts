/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { runResultToActionState } from "../../actions/base"
import { renderMessageWithDivider } from "../../logger/util"
import { sdk } from "../../plugin/sdk"
import { copyArtifacts, execRunCommand } from "./common"
import { execRunSpecSchema, execRuntimeOutputsSchema, execStaticOutputsSchema } from "./config"
import { execProvider } from "./exec"

export const execRun = execProvider.createActionType({
  kind: "Run",
  name: "exec",
  docs: sdk.util.dedent`
    A simple Run action which runs a command locally with a shell command.
  `,
  specSchema: execRunSpecSchema,
  staticOutputsSchema: execStaticOutputsSchema,
  runtimeOutputsSchema: execRuntimeOutputsSchema,
})

export type ExecRunConfig = typeof execRun.T.Config
export type ExecRun = typeof execRun.T.Action

execRun.addHandler("run", async ({ artifactsPath, log, action, ctx }) => {
  const { command, env, artifacts } = action.getSpec()
  const startedAt = new Date()

  let completedAt: Date
  let outputLog: string
  let success = true

  if (command && command.length) {
    const commandResult = await execRunCommand({ command, action, ctx, log, env, opts: { reject: false } })

    completedAt = new Date()
    outputLog = commandResult.all?.trim() || ""
    success = commandResult.exitCode === 0
  } else {
    completedAt = startedAt
    outputLog = ""
  }

  const { chalk } = sdk.util

  if (outputLog) {
    const prefix = `Finished running task ${chalk.white(action.name)}. Here is the full output:`
    log.verbose(
      renderMessageWithDivider({
        prefix,
        msg: outputLog,
        isError: false,
        color: chalk.gray,
      })
    )
  }

  await copyArtifacts(log, artifacts, action.getBuildPath(), artifactsPath)

  const detail = {
    moduleName: action.moduleName(),
    taskName: action.name,
    command,
    version: action.versionString(),
    success,
    log: outputLog,
    outputs: {
      log: outputLog,
    },
    startedAt,
    completedAt,
  }

  return {
    state: runResultToActionState(detail),
    detail,
    outputs: {
      log: outputLog,
    },
  }
})
