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

const s = sdk.schema

export const execTestSpecSchema = execRunSpecSchema

export const execTest = execProvider.createActionType({
  kind: "Test",
  name: "exec",
  docs: sdk.util.dedent`
    A simple Test action which runs a command locally with a shell command.
  `,
  specSchema: execRunSpecSchema,
  staticOutputsSchema: execStaticOutputsSchema,
  runtimeOutputsSchema: execRuntimeOutputsSchema,
})

export type ExecTestConfig = typeof execTest.T.Config
export type ExecTest = typeof execTest.T.Action

execTest.addHandler("run", async ({ log, action, artifactsPath, ctx }) => {
  const startedAt = new Date()
  const { command, env } = action.getSpec()

  const result = await execRunCommand({ command, action, ctx, log, env, opts: { reject: false } })

  const artifacts = action.getSpec("artifacts")
  await copyArtifacts(log, artifacts, action.getBuildPath(), artifactsPath)

  const { chalk } = sdk.util

  const outputLog = result.all?.trim() || ""
  if (outputLog) {
    const prefix = `Finished executing ${chalk.white(action.key())}. Here is the full output:`
    log.verbose(
      renderMessageWithDivider({
        prefix,
        msg: outputLog,
        isError: false,
        color: chalk.gray,
      })
    )
  }

  const detail = {
    moduleName: action.moduleName(),
    command,
    testName: action.name,
    version: action.versionString(),
    success: result.exitCode === 0,
    startedAt,
    completedAt: new Date(),
    log: outputLog,
  }

  return {
    state: runResultToActionState(detail),
    detail,
    outputs: {
      log: outputLog,
    },
  }
})
