/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { renderMessageWithDivider } from "../../logger/util"
import { sdk } from "../../plugin/sdk"
import { execRunCommand } from "./common"
import { execCommonSchema, execEnvVarDoc, execRuntimeOutputsSchema, execStaticOutputsSchema } from "./config"
import { execProvider } from "./exec"

const s = sdk.schema

export const execBuildSpecSchema = execCommonSchema.extend({
  command: s
    .array(s.string())
    .default([])
    .describe(
      sdk.util.dedent`
        The command to run to perform the build.

        _Note: You may omit this if all you need is for other implicit actions to happen, like copying files from build dependencies etc._

        By default, the command is run inside the Garden build directory (under .garden/build/<build-name>). If the top level \`buildAtSource\` directive is set to \`true\`, the command runs in the action source directory instead. Please see the docs for that field for more information and potential implications. Also note that other \`exec\` actions that reference this build via the \`build\` field will then also run from this action's source directory.
      `
    )
    .example(["npm", "run", "build"]),
  env: s.envVars().default({}).describe(execEnvVarDoc),
})

export const execBuild = execProvider.createActionType({
  kind: "Build",
  name: "exec",
  docs: sdk.util.dedent`
    A simple Build action which runs a build locally with a shell command.
  `,
  specSchema: execBuildSpecSchema,
  staticOutputsSchema: execStaticOutputsSchema,
  runtimeOutputsSchema: execRuntimeOutputsSchema,
})

export type ExecBuildConfig = typeof execBuild.T.Config
export type ExecBuild = typeof execBuild.T.Action

export const execBuildHandler = execBuild.addHandler("build", async ({ action, log, ctx }) => {
  const output: sdk.types.BuildStatus = { state: "ready", outputs: {}, detail: {} }
  const command = action.getSpec("command")

  const { chalk } = sdk.util

  if (command?.length) {
    const result = await execRunCommand({ command, action, ctx, log })

    if (!output.detail) {
      output.detail = {}
    }

    output.detail.fresh = true
    output.detail.buildLog = result.all || result.stdout + result.stderr
  }

  if (output.detail?.buildLog) {
    output.outputs.log = output.detail?.buildLog

    const prefix = `Finished building ${chalk.white(action.name)}. Here is the full output:`
    log.verbose(
      renderMessageWithDivider({
        prefix,
        msg: output.detail?.buildLog,
        isError: false,
        color: chalk.gray,
      })
    )
  }

  return output
})
