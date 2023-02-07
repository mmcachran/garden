/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import indentString from "indent-string"
import { Key } from "ink"
import sliceAnsi from "slice-ansi"
import { Command, CommandGroup, CommandResult } from "../commands/base"
import { getCustomCommands } from "../commands/custom"
import { ConfigDump, Garden } from "../garden"
import { LogEntry } from "../logger/log-entry"
import { renderDivider } from "../logger/util"
import { TypedEventEmitter } from "../util/events"
import { Autocompleter, AutocompleteSuggestion } from "./autocomplete"
import { parseCliArgs, pickCommand, processCliArgs, renderCommandErrors, renderCommands } from "./helpers"
import { GlobalOptions, ParameterValues } from "./params"

const defaultMessageDuration = 3000
const commandLinePrefix = chalk.yellow("🌼  > ")
const emptyCommandLinePlaceholder = chalk.gray("<enter command> (enter help for more info)")
const inputChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789- _*!@$%&/="

export type SetStringCallback = (data: string) => void

type KeyHandler = (input: string, key: Key) => void

const directInputKeys = [
  "upArrow",
  "downArrow",
  "leftArrow",
  "rightArrow",
  "pageDown",
  "pageUp",
  "return",
  "escape",
  "tab",
  "delete",
]

const hideCommands = ["config analytics-enabled", "tools"]

interface CommandLineEvents {
  message: string
}

export class CommandLine extends TypedEventEmitter<CommandLineEvents> {
  private enabled: boolean

  private currentCommand: string
  private cursorPosition: number
  private historyIndex: number
  private suggestionIndex: number
  private autocompletingFrom: number
  private commandHistory: string[]
  private showCursor: boolean

  private keyHandlers: { [key: string]: KeyHandler }

  private commandLineCallback: SetStringCallback
  private messageCallback: SetStringCallback
  private messageTimeout: NodeJS.Timeout

  private autocompleter: Autocompleter
  private garden: Garden
  private readonly log: LogEntry
  private commands: Command[]
  private readonly globalOpts: Partial<ParameterValues<GlobalOptions>>

  constructor({
    garden,
    log,
    commands,
    configDump,
    globalOpts,
  }: {
    garden: Garden
    log: LogEntry
    commands: Command[]
    configDump?: ConfigDump
    globalOpts: Partial<ParameterValues<GlobalOptions>>
  }) {
    super()

    this.garden = garden
    this.log = log
    this.commands = commands
    this.globalOpts = globalOpts

    this.enabled = true
    this.currentCommand = ""
    this.cursorPosition = 0
    this.historyIndex = 0
    this.suggestionIndex = -1
    this.autocompletingFrom = -1
    this.commandHistory = []
    this.showCursor = true

    // This does nothing until a callback is supplied from outside
    this.commandLineCallback = () => {}
    this.messageCallback = () => {}
    this.keyHandlers = {}

    this.autocompleter = new Autocompleter({ log, commands, configDump, debug: true })
    this.init()
  }

  async update(garden: Garden, configDump: ConfigDump) {
    const customCommands = await getCustomCommands(garden.projectRoot)

    this.commands = this.commands.filter((c) => !c.isCustom).concat(customCommands)
    this.garden = garden
    this.autocompleter = new Autocompleter({ log: this.log, commands: this.commands, configDump, debug: true })
  }

  setCommandLineCallback(cb: SetStringCallback) {
    this.commandLineCallback = cb
  }

  setMessageCallback(cb: SetStringCallback) {
    this.messageCallback = cb
  }

  getBlankCommandLine() {
    return commandLinePrefix + emptyCommandLinePlaceholder
  }

  keyStroke(input: string, key: Key) {
    if (!this.enabled) {
      return
    }

    let stringKey = input

    if (input === "[1~") {
      stringKey = "fn-leftArrow"
    } else if (input === "[4~") {
      stringKey = "fn-rightArrow"
    } else if (key.ctrl && !key.tab) {
      stringKey = "ctrl-" + stringKey
    } else if (key.delete && !key.meta) {
      // Seems to be needed at least for macbooks, may be an Ink bug.
      stringKey = "backspace"
    } else {
      for (const k of directInputKeys) {
        if (key[k]) {
          stringKey = k
          break
        }
      }
    }

    const handler = this.keyHandlers[stringKey]

    if (handler) {
      handler(input, key)
    }
  }

  private setCommandLine(line: string) {
    this.commandLineCallback(line)
  }

  private init() {
    // Character input
    const characterHandler: KeyHandler = (char) => {
      this.currentCommand =
        this.currentCommand.substring(0, this.cursorPosition) +
        char +
        this.currentCommand.substring(this.cursorPosition)
      this.moveCursor(this.cursorPosition + 1)
      this.renderCommandLine()
    }

    for (const char of inputChars.split("")) {
      this.setKeyHandler(char, characterHandler)
    }

    // Delete
    this.setKeyHandler("backspace", () => {
      if (this.cursorPosition > 0) {
        this.currentCommand =
          this.currentCommand.substring(0, this.cursorPosition - 1) + this.currentCommand.substring(this.cursorPosition)
        this.moveCursor(this.cursorPosition - 1)
        this.renderCommandLine()
      }
    })

    this.setKeyHandler("delete", () => {
      this.currentCommand =
        this.currentCommand.substring(0, this.cursorPosition) + this.currentCommand.substring(this.cursorPosition + 1)
      this.renderCommandLine()
    })

    // Move cursor
    this.setKeyHandler("leftArrow", () => {
      if (this.cursorPosition > 0) {
        this.moveCursor(this.cursorPosition - 1)
        this.renderCommandLine()
      }
    })

    this.setKeyHandler("rightArrow", () => {
      if (this.cursorPosition < this.currentCommand.length) {
        this.moveCursor(this.cursorPosition + 1)
        this.renderCommandLine()
      }
    })

    this.setKeyHandler("ctrl-a", () => {
      this.moveCursor(0)
      this.renderCommandLine()
    })

    this.setKeyHandler("fn-leftArrow", () => {
      this.moveCursor(0)
      this.renderCommandLine()
    })

    this.setKeyHandler("fn-rightArrow", () => {
      this.moveCursor(this.currentCommand.length)
      this.renderCommandLine()
    })

    // Execute
    this.setKeyHandler("return", () => this.handleReturn())

    // Autocomplete
    this.setKeyHandler("tab", () => {
      if (this.cursorPosition === 0) {
        return
      }
      const suggestions = this.getSuggestions(
        this.autocompletingFrom > -1 ? this.autocompletingFrom : this.cursorPosition
      )
      if (suggestions.length > 0) {
        this.suggestionIndex++
        if (this.suggestionIndex >= suggestions.length) {
          this.suggestionIndex = 0
        }
        // Pick the suggestion but remember where we are completing from, so we can roll through more suggestions
        this.currentCommand = suggestions[this.suggestionIndex].line
        if (this.autocompletingFrom === -1) {
          this.autocompletingFrom = this.cursorPosition
        }
        // Not using this.moveCursor() here so we don't reset the autocomplete state
        this.cursorPosition = this.currentCommand.length
        this.renderCommandLine()
      } else {
        this.suggestionIndex = -1
      }
    })

    // Scroll through history
    this.setKeyHandler("upArrow", () => {
      if (this.historyIndex > 0) {
        this.historyIndex--
        this.currentCommand = this.commandHistory[this.historyIndex]
        this.moveCursor(this.currentCommand.length)
        this.renderCommandLine()
      }
    })

    this.setKeyHandler("downArrow", () => {
      if (this.historyIndex < this.commandHistory.length) {
        this.currentCommand = this.commandHistory[this.historyIndex]
        this.moveCursor(this.currentCommand.length)
        this.historyIndex++
      } else if (this.historyIndex > 0) {
        this.currentCommand = ""
        this.moveCursor(0)
        this.historyIndex = this.commandHistory.length
      }
      this.renderCommandLine()
    })

    // Clear from cursor back
    this.setKeyHandler("ctrl-u", () => {
      this.currentCommand = this.currentCommand.substring(this.cursorPosition)
      this.moveCursor(0)
      this.renderCommandLine()
    })

    // Clear line if at beginning
    this.setKeyHandler("ctrl-k", () => {
      if (this.cursorPosition === 0) {
        this.currentCommand = ""
        this.renderCommandLine()
      }
    })

    this.enabled = true
    this.renderCommandLine()

    setInterval(() => {
      this.showCursor = !this.showCursor
      this.renderCommandLine()
    }, 600)
  }

  renderCommandLine() {
    if (!this.enabled) {
      return
    }

    let renderedCommand = this.currentCommand

    const suggestions = this.getSuggestions(this.currentCommand.length)

    if (this.isSuggestedCommand(suggestions)) {
      renderedCommand = chalk.cyan(renderedCommand)
    }

    if (suggestions.length > 0) {
      // Show autocomplete suggestion after string
      renderedCommand = renderedCommand + chalk.gray(suggestions[0].line.substring(renderedCommand.length))
    }

    if (renderedCommand.length === 0) {
      if (this.showCursor) {
        renderedCommand = chalk.underline(sliceAnsi(emptyCommandLinePlaceholder, 0, 1))
          + sliceAnsi(emptyCommandLinePlaceholder, 1)
      } else {
        renderedCommand = emptyCommandLinePlaceholder
      }
    } else if (this.cursorPosition === renderedCommand.length) {
      renderedCommand = renderedCommand + (this.showCursor ? "_" : " ")
    } else {
      const cursorChar = sliceAnsi(renderedCommand, this.cursorPosition, this.cursorPosition + 1)

      renderedCommand =
        sliceAnsi(renderedCommand, 0, this.cursorPosition) +
        (this.showCursor ? chalk.underline(cursorChar) : cursorChar) +
        sliceAnsi(renderedCommand, this.cursorPosition + 1)
    }

    this.setCommandLine(commandLinePrefix + renderedCommand)
  }

  disable(message: string) {
    this.enabled = false
    this.setCommandLine(message)
  }

  enable() {
    this.enabled = true
    this.renderCommandLine()
  }

  showHelp() {
    // TODO: group commands by category?
    const width = (process.stdout?.columns || 100) - 8
    const renderedCommands = renderCommands(
      this.commands.filter((c) => !(c.hidden || c instanceof CommandGroup || hideCommands.includes(c.getFullName())))
    )

    const helpText = `
${renderDivider({ title: chalk.bold("help"), width })}
${chalk.white.bold("Available commands:")}

${renderedCommands}

${chalk.white.bold("Keys:")}

  ${chalk.gray(`[tab]: auto-complete  [up/down]: command history  [ctrl-d]: quit`)}
${renderDivider({ width })}
`

    this.log.info(indentString(helpText, 2, { indent: " " }))
  }

  /**
   * Flash the given `message` in the command line for `duration` milliseconds, meanwhile disabling the command line.
   */
  flashMessage(message: string, opts: FlashOpts = {}) {
    clearTimeout(this.messageTimeout)

    const prefix = opts.prefix || chalk.cyan("ℹ︎ ")
    this.messageCallback(prefix + message)

    this.messageTimeout = setTimeout(() => {
      this.messageCallback("")
    }, opts.duration || defaultMessageDuration)
  }

  flashSuccess(message: string, opts: FlashOpts = {}) {
    this.flashMessage(chalk.green(message), { prefix: chalk.green("✔︎  "), ...opts })
  }

  flashError(message: string, opts: FlashOpts = {}) {
    this.flashMessage(chalk.red(message), { prefix: "❗️  ", ...opts })
  }

  flashWarning(message: string, opts: FlashOpts = {}) {
    this.flashMessage(chalk.yellowBright(message), { prefix: chalk.yellow("⚠️  "), ...opts })
  }

  setKeyHandler(stringKey: string, handler: KeyHandler) {
    this.keyHandlers[stringKey] = handler
  }

  private moveCursor(position: number) {
    this.cursorPosition = position
    this.autocompletingFrom = -1
    this.suggestionIndex = -1
  }

  private handleReturn() {
    if (this.currentCommand.trim() === "") {
      return
    }

    const rawArgs = this.currentCommand.split(" ")
    const { command, rest, matchedPath } = pickCommand(this.commands, rawArgs)

    if (command) {
      // Push the command to the top of the history
      this.commandHistory = [...this.commandHistory.filter((cmd) => cmd !== this.currentCommand), this.currentCommand]
      this.historyIndex = this.commandHistory.length

      // Update command line
      this.currentCommand = ""
      this.moveCursor(0)
      this.renderCommandLine()

      // Prepare args and opts
      const parsedArgs = parseCliArgs({ stringArgs: rest, command, cli: false, skipGlobalDefault: true })
      const { args, opts } = processCliArgs({
        log: this.log,
        rawArgs,
        parsedArgs,
        command,
        matchedPath,
        cli: false,
        inheritedOpts: this.globalOpts,
        warnOnGlobalOpts: true,
      })

      // Execute the command
      if (!command.isInteractive) {
        this.flashMessage(`Running ${chalk.white.bold(command.getFullName())}...`)
      }
      const failMessage = `Failed running the ${command.getFullName()} command. Please see above for the logs.`

      command
        .action({
          garden: this.garden,
          log: this.log,
          headerLog: this.log,
          footerLog: this.log,
          args,
          opts,
          commandLine: this,
        })
        .then((output: CommandResult) => {
          if (output.errors?.length) {
            renderCommandErrors(this.log.root, output.errors, this.log)
            this.flashError(failMessage)
          } else if (!command.isInteractive) {
            this.flashSuccess(`${chalk.whiteBright(command.getFullName())} command completed successfully!`)
          }
        })
        .catch(() => {
          this.flashError(failMessage)
        })
    } else {
      this.flashError(`Could not find command. Try typing ${chalk.white("help")} to see the available commands.`)
    }
  }

  private getSuggestions(from: number): AutocompleteSuggestion[] {
    if (from === 0) {
      return []
    }

    const input = this.currentCommand.substring(0, from)
    return this.autocompleter.getSuggestions(input, { ignoreGlobalFlags: true })
  }

  private isSuggestedCommand(suggestions: AutocompleteSuggestion[]) {
    // TODO: we may want to tune this
    for (const s of suggestions) {
      if (this.currentCommand === s.line) {
        return true
      }
    }
    return false
  }
}

interface FlashOpts {
  prefix?: string
  duration?: number
}