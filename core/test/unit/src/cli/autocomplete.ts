/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { expect } from "chai"
import { Autocompleter } from "../../../../src/cli/autocomplete"
import { globalOptions } from "../../../../src/cli/params"
import { BuildCommand } from "../../../../src/commands/build"
import { getBuiltinCommands } from "../../../../src/commands/commands"
import { ConfigDump } from "../../../../src/garden"
import { makeTestGardenA, TestGarden } from "../../../helpers"

describe("Autocompleter", () => {
  let garden: TestGarden
  let configDump: ConfigDump
  let ac: Autocompleter

  const globalFlags = Object.keys(globalOptions)
  const buildFlags = Object.keys(new BuildCommand().options)
  const flags = [...globalFlags, ...buildFlags].map((f) => "--" + f)

  const commands = getBuiltinCommands()

  before(async () => {
    garden = await makeTestGardenA()
    configDump = await garden.dumpConfig({ log: garden.log })
    ac = new Autocompleter({ log: garden.log, commands, debug: true })
  })

  it("suggests nothing with empty input", () => {
    const result = ac.getSuggestions("")
    expect(result).to.eql([])
  })

  it("suggests nothing with all-space input", () => {
    const result = ac.getSuggestions("  ")
    expect(result).to.eql([])
  })

  it("returns one command on close match", () => {
    const result = ac.getSuggestions("buil")
    expect(result.length).to.equal(1)
    expect(result[0]).to.eql({
      type: "command",
      line: "build",
      command: ["build"],
      priority: 1,
    })
  })

  it("returns many command names including subcommands with short input", () => {
    const result = ac.getSuggestions("lo")
    // Not testing for the ordering here, easiest to sort alphabetically
    expect(result.map((s) => s.line).sort()).to.eql(["login", "logout", "logs"])
  })

  it("returns command names sorted by length", () => {
    const result = ac.getSuggestions("lo")
    // Not testing for the ordering here, easiest to sort alphabetically
    expect(result.map((s) => s.line)).to.eql(["logs", "login", "logout"])
  })

  it("returns subcommands when matching on command group", () => {
    const result = ac.getSuggestions("link")
    expect(result.map((s) => s.line).sort()).to.eql(["link module", "link source"])
  })

  context("without config dump", () => {
    it("returns option flags after matched command", () => {
      const result = ac.getSuggestions("build")

      const lines = result.map((s) => s.line)

      for (const s of flags) {
        expect(lines).to.include("build " + s)
      }
    })

    it("skips global option flags when ignoreGlobalFlags=true", () => {
      const result = ac.getSuggestions("build")

      const lines = result.map((s) => s.line)

      for (const s of buildFlags.map((f) => "--" + f)) {
        expect(lines).to.include("build " + s)
      }
    })
  })

  context("with config dump", () => {
    beforeEach(() => {
      ac = new Autocompleter({ log: garden.log, commands, configDump, debug: true })
    })

    it("returns suggested positional args and option flags after matched command", () => {
      const result = ac.getSuggestions("build")

      const lines = result.map((s) => s.line)

      for (const s of [...flags, ...Object.keys(configDump.actionConfigs.Build)]) {
        expect(lines).to.include("build " + s)
      }
    })

    it("ranks positional args above option flags", () => {
      const result = ac.getSuggestions("build")
      const lines = result.map((s) => s.line)
      expect(lines[0]).to.equal("build module-a")
      expect(lines[1]).to.equal("build module-b")
      expect(lines[2]).to.equal("build module-c")
      expect(lines[3].startsWith("build --")).to.be.true
    })

    it("returns suggested positional args and option flags after matched command and space", () => {
      const result = ac.getSuggestions("build ")

      const lines = result.map((s) => s.line)

      for (const s of [...flags, ...Object.keys(configDump.actionConfigs.Build)]) {
        expect(lines).to.include("build " + s)
      }
    })

    it("returns nothing if typing a positional argument that matches no suggested value", () => {
      const result = ac.getSuggestions("build z")
      expect(result).to.eql([])
    })
  })
})