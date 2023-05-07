/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { CommandResult, CommandParams, ConsoleCommand } from "./base"
import { renderDivider } from "../logger/util"
import React, { FC, useState } from "react"
import { Box, render, Text, useInput, useStdout } from "ink"
import { serveArgs, ServeCommand, serveOpts } from "./serve"
import { LoggerType } from "../logger/logger"
import { ParameterError } from "../exceptions"
import { InkTerminalWriter } from "../logger/writers/ink-terminal-writer"
import { CommandLine } from "../cli/command-line"
import chalk from "chalk"
import { globalOptions } from "../cli/params"
import { pick } from "lodash"
import Divider from "ink-divider"
import moment from "moment"
import { getBuiltinCommands } from "./commands"

const devCommandArgs = {
  ...serveArgs,
}
const devCommandOpts = {
  ...serveOpts,
}

type DevCommandArgs = typeof devCommandArgs
type DevCommandOpts = typeof devCommandOpts
type ActionParams = CommandParams<DevCommandArgs, DevCommandOpts>

export class DevCommand extends ServeCommand<DevCommandArgs, DevCommandOpts> {
  name = "dev"
  help = "Starts the Garden interactive development console."

  protected = true
  cliOnly = true

  arguments = devCommandArgs
  options = devCommandOpts

  printHeader({ headerLog }) {
    const width = process.stdout?.columns ? process.stdout?.columns - 2 : 100

    console.clear()

    headerLog.info(
      chalk.magenta(`
${renderDivider({ color: chalk.green, title: chalk.green.bold("🌳  garden dev 🌳 "), width })}

${chalk.bold(`Good ${getGreetingTime()}! Welcome to the Garden interactive development console.`)}
Let's get your development environment wired up.
    `)
    )
  }

  getTerminalWriterType(): LoggerType {
    return "ink"
  }

  allowInDevCommand() {
    return false
  }

  async action(params: ActionParams): Promise<CommandResult> {
    const logger = params.log.root
    const terminalWriter = logger.getWriters().display

    let inkWriter: InkTerminalWriter
    // TODO: maybe enforce this elsewhere
    if (terminalWriter.type === "ink") {
      inkWriter = terminalWriter as InkTerminalWriter
    } else {
      throw new ParameterError(`This command can only be used with the ink logger type`, {
        writerTypes: {
          terminalWriter: terminalWriter.type,
          fileWriters: logger.getWriters().file.map((w) => w.type),
        },
      })
    }

    const commandLine = await this.initCommandHandler(params)

    const Dev: FC<{}> = ({}) => {
      // Stream log output directly to stdout, on top of the Ink components below
      const { stdout, write } = useStdout()
      inkWriter.setWriteCallback(write)

      const [line, setLine] = useState(commandLine.getBlankCommandLine())
      const [status, setStatus] = useState("")
      const [message, setMessage] = useState("")

      // Note: Using callbacks here instead of events to make keypresses a bit more responsive
      commandLine.setCallbacks({
        commandLine: setLine,
        message: setMessage,
        status: setStatus,
      })

      useInput((input, key) => {
        commandLine.keyStroke(input, key)
      })

      const width = stdout ? stdout.columns - 2 : 50

      return (
        <Box flexDirection="column" paddingTop={1}>
          <Divider title={"🌼 🌸 🌷 🌺 🌻 "} width={width} dividerColor={"green"} padding={0} />
          <Box height={1} marginLeft={1}>
            <Text>{line}</Text>
          </Box>
          <Box height={1} marginTop={1} marginLeft={2}>
            <Text>{message || status}</Text>
          </Box>
        </Box>
      )
    }

    render(<Dev />)

    // TODO: detect config changes and notify user in status

    return super.action({ ...params, commandLine })
  }

  private async initCommandHandler(params: ActionParams) {
    const _this = this
    const { garden, log, opts } = params

    // Custom commands are loaded later, along with the project config
    const commands = getBuiltinCommands()

    /**
     * Help/utility commands
     */
    const cl = (this.commandLine = new CommandLine({
      garden,
      log,
      commands: [...commands, new HelpCommand(), new QuitCommand(quit), new QuietCommand(), new QuiteCommand()],
      configDump: undefined, // This gets loaded later
      globalOpts: pick(opts, Object.keys(globalOptions)),
      history: await garden.localConfigStore.get("devCommandHistory"),
    }))

    function quit() {
      cl?.disable("🌷  Thanks for stopping by, love you! ❤️")
      _this.terminate()
    }

    process.on("SIGINT", quit)

    // Support ctrl-c and ctrl-d to exit
    cl.setKeyHandler("ctrl-d", quit)
    cl.setKeyHandler("ctrl-c", quit)

    return cl
  }
}

class HelpCommand extends ConsoleCommand {
  name = "help"
  help = ""
  hidden = true

  async action({ commandLine }: CommandParams) {
    commandLine?.showHelp()
    return {}
  }
}

class QuitCommand extends ConsoleCommand {
  name = "quit"
  help = "Exit the dev console."
  aliases = ["exit"]

  constructor(private quit: () => void) {
    super()
  }

  async action() {
    this.quit()
    return {}
  }
}

class QuietCommand extends ConsoleCommand {
  name = "quiet"
  help = ""
  hidden = true

  async action({ commandLine }: CommandParams) {
    commandLine?.flashMessage(chalk.italic("Shh!"), { prefix: "🤫  " })
    return {}
  }
}

class QuiteCommand extends ConsoleCommand {
  name = "quite"
  help = ""
  hidden = true

  async action({ commandLine }: CommandParams) {
    commandLine?.flashMessage(chalk.italic("Indeed!"), { prefix: "🎩  " })
    return {}
  }
}

function getGreetingTime() {
  const m = moment()

  const currentHour = parseFloat(m.format("HH"))

  if (currentHour >= 17) {
    return "evening"
  } else if (currentHour >= 12) {
    return "afternoon"
  } else {
    return "morning"
  }
}