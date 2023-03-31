/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { expect } from "chai"
import Stream from "ts-stream"
import { ResolvedDeployAction } from "../../../../src/actions/deploy"
import { ConfigGraph } from "../../../../src/graph/config-graph"
import { Log } from "../../../../src/logger/log-entry"
import { ActionRouter } from "../../../../src/router/router"
import { DeployLogEntry } from "../../../../src/types/service"
import { TestGarden, expectError } from "../../../helpers"
import { getRouterTestData } from "./_helpers"

describe("deploy actions", () => {
  let garden: TestGarden
  let graph: ConfigGraph
  let log: Log
  let actionRouter: ActionRouter
  let resolvedDeployAction: ResolvedDeployAction
  let returnWrongOutputsCfgKey: string

  before(async () => {
    const data = await getRouterTestData()
    garden = data.garden
    graph = data.graph
    log = data.log
    actionRouter = data.actionRouter
    resolvedDeployAction = data.resolvedDeployAction
    returnWrongOutputsCfgKey = data.returnWrongOutputsCfgKey
  })

  after(async () => {
    await garden.close()
  })

  afterEach(() => {
    resolvedDeployAction._config[returnWrongOutputsCfgKey] = false
  })

  describe("deploy.getStatus", () => {
    it("should correctly call the corresponding plugin handler", async () => {
      const { result } = await actionRouter.deploy.getStatus({
        log,
        action: resolvedDeployAction,
        graph,
      })
      expect(result).to.eql({
        detail: { forwardablePorts: [], state: "ready", outputs: {}, detail: {}, mode: "default" },
        outputs: { base: "ok", foo: "ok" },
        state: "ready",
      })
    })

    it("should emit serviceStatus events", async () => {
      garden.events.eventLog = []
      await actionRouter.deploy.getStatus({
        log,
        action: resolvedDeployAction,
        graph,
      })
      const event1 = garden.events.eventLog[0]
      const event2 = garden.events.eventLog[1]

      expect(event1).to.exist
      expect(event2).to.exist

      expect(event1.name).to.eql("deployStatus")
      expect(event1.payload.actionVersion).to.eql(resolvedDeployAction.versionString())
      expect(event1.payload.moduleName).to.eql("module-a")
      expect(event1.payload.actionUid).to.be.ok
      expect(event1.payload.state).to.eql("getting-status")
      expect(event1.payload.status.state).to.eql("unknown")

      expect(event2.name).to.eql("deployStatus")
      expect(event2.payload.actionVersion).to.eql(resolvedDeployAction.versionString())
      expect(event2.payload.moduleName).to.eql("module-a")
      expect(event2.payload.actionUid).to.eql(event1.payload.actionUid)
      expect(event2.payload.state).to.eql("cached")
      expect(event2.payload.status.state).to.eql("ready")
    })

    it("should throw if the outputs don't match the service outputs schema of the plugin", async () => {
      resolvedDeployAction._config[returnWrongOutputsCfgKey] = true
      await expectError(
        () =>
          actionRouter.deploy.getStatus({
            log,
            action: resolvedDeployAction,
            graph,
          }),
        { contains: "Error validating runtime action outputs from Deploy 'service-a': key .foo must be a string." }
      )
    })
  })

  describe("deploy.deploy", () => {
    it("should correctly call the corresponding plugin handler", async () => {
      const { result } = await actionRouter.deploy.deploy({
        log,
        action: resolvedDeployAction,
        graph,
        force: true,
      })
      expect(result).to.eql({
        detail: { forwardablePorts: [], state: "ready", outputs: {}, detail: {}, mode: "default" },
        outputs: { base: "ok", foo: "ok" },
        state: "ready",
      })
    })

    it("should emit serviceStatus events", async () => {
      garden.events.eventLog = []
      await actionRouter.deploy.deploy({
        log,
        action: resolvedDeployAction,
        graph,
        force: true,
      })
      const moduleVersion = resolvedDeployAction.moduleVersion().versionString
      const event1 = garden.events.eventLog[0]
      const event2 = garden.events.eventLog[1]
      expect(event1).to.exist
      expect(event1.name).to.eql("deployStatus")
      expect(event1.payload.moduleName).to.eql("module-a")
      expect(event1.payload.actionUid).to.be.ok
      expect(event1.payload.state).to.eql("processing")
      expect(event1.payload.status.state).to.eql("deploying")
      expect(event2).to.exist
      expect(event2.name).to.eql("deployStatus")
      expect(event2.payload.moduleName).to.eql("module-a")
      expect(event2.payload.actionUid).to.eql(event2.payload.actionUid)
      expect(event2.payload.state).to.eql("ready")
      expect(event2.payload.status.state).to.eql("ready")
    })

    it("should throw if the outputs don't match the service outputs schema of the plugin", async () => {
      resolvedDeployAction._config[returnWrongOutputsCfgKey] = true
      await expectError(
        () =>
          actionRouter.deploy.deploy({
            log,
            action: resolvedDeployAction,
            graph,
            force: true,
          }),
        { contains: "Error validating runtime action outputs from Deploy 'service-a': key .foo must be a string." }
      )
    })
  })

  describe("deploy.delete", () => {
    it("should correctly call the corresponding plugin handler", async () => {
      const { result } = await actionRouter.deploy.delete({ log, action: resolvedDeployAction, graph })
      expect(result).to.eql({
        state: "ready",
        detail: {
          forwardablePorts: [],
          outputs: {},
          detail: {},
          state: "ready",
          mode: "default",
        },
        outputs: {},
      })
    })
  })

  describe("deploy.exec", () => {
    it("should correctly call the corresponding plugin handler", async () => {
      const executedAction = await garden.executeAction({ action: resolvedDeployAction, log, graph, force: false })
      const { result } = await actionRouter.deploy.exec({
        log,
        action: executedAction,
        graph,
        command: ["foo"],
        interactive: false,
      })
      expect(result).to.eql({ code: 0, output: "bla bla" })
    })
  })

  describe("deploy.getLogs", () => {
    it("should correctly call the corresponding plugin handler", async () => {
      const stream = new Stream<DeployLogEntry>()
      const { result } = await actionRouter.deploy.getLogs({
        log,
        action: resolvedDeployAction,
        graph,
        stream,
        follow: false,
        tail: -1,
      })
      expect(result).to.eql({})
    })
  })
})
