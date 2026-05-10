/*
 * Regression coverage for issue #26671 — TUI does not live-render messages when
 * an external HTTP client POSTs to /session/{id}/prompt_async on the same
 * server, even though the web UI renders them correctly.
 *
 * The hypothesis under test: prompt_async forks via Effect.forkIn(scope), and
 * the forked work emits GlobalBus events (the same bus the SSE /event endpoint
 * forwards). Per #26586, Effect.forkIn preserves InstanceRef/WorkspaceRef
 * across the fork, so events emitted inside the fork should carry the
 * request's directory and workspace.
 *
 * Test 1 (live request): mount the in-process server, create a session in a
 * tmp directory (no workspace), POST /session/{id}/prompt_async, and assert
 * that some GlobalBus event scoped to the session fires with
 * { directory: <tmp.path>, workspace: undefined }. If this fails, the bug is
 * in event publishing. If it passes, publishing is correct and the bug lives
 * in the TUI's client-side filter.
 *
 * Test 2 (synthetic filter): replicate the TUI useEvent filter shape from
 * packages/opencode/src/cli/cmd/tui/context/event.ts and prove the filter
 * drops events when the TUI has an active workspace but the inbound event has
 * workspace=undefined — even when the directory matches. That early `return`
 * in the workspace branch is the smoking gun.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { WithInstance } from "../../src/project/with-instance"
import { Server } from "../../src/server/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { waitGlobalBusEventPromise } from "./global-bus"

void Log.init({ print: false })

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES

function app() {
  return Server.Default().app
}

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function runSession<A, E>(fx: Effect.Effect<A, E, Session.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Session.defaultLayer)))
}

function createSession(directory: string, input?: Session.CreateInput) {
  return WithInstance.provide({
    directory,
    fn: () => runSession(Session.Service.use((svc) => svc.create(input))),
  })
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("session prompt_async events (issue #26671)", () => {
  test("forks publish GlobalBus events with the request's directory/workspace", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const session = await createSession(tmp.path, { title: "external prompt" })

    // Subscribe BEFORE posting so we don't miss the first emit. The
    // GlobalBus.on inside Effect.callback registers synchronously when the
    // outer Promise is created, so kicking the request after this line is
    // safe.
    const eventPromise = waitGlobalBusEventPromise({
      timeout: 8_000,
      message: "no GlobalBus event observed for prompt_async",
      // Match the first non-housekeeping event scoped to this session. The
      // exact event type depends on how far the prompt gets before failing
      // (no provider configured): the user-message persistence emits sync
      // events, and any subsequent failure emits Session.Event.Error.
      predicate: (event) => {
        if (event.payload.type === "server.heartbeat") return false
        if (event.payload.type === "server.connected") return false
        // Attached payload always serialises the sessionID for session events.
        return JSON.stringify(event.payload).includes(session.id)
      },
    })

    const promptAsyncPath = pathFor(SessionPaths.promptAsync, { sessionID: session.id })
    const response = await app().request(promptAsyncPath, {
      method: "POST",
      headers: {
        "x-opencode-directory": tmp.path,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        parts: [{ type: "text", text: "hello from external POST" }],
      }),
    })

    // prompt_async returns 204 immediately; the work continues in the fork.
    expect(response.status).toBe(204)

    const event = await eventPromise
    expect(event.directory).toBe(tmp.path)
    expect(event.workspace).toBeUndefined()
  })

  test("TUI useEvent filter drops events when active workspace is set but event.workspace is undefined", () => {
    // Mirrors the filter at packages/opencode/src/cli/cmd/tui/context/event.ts
    // exactly so we can document the behaviour that #26671 is observing.
    type IncomingEvent = {
      directory: string | undefined
      workspace: string | undefined
      payload: { type: string }
    }
    function tuiFilter(input: {
      event: IncomingEvent
      activeWorkspace: string | undefined
      activeDirectory: string
    }): boolean {
      const { event, activeWorkspace, activeDirectory } = input
      if (event.payload.type === "sync") return false
      if (event.directory === "global") return true

      if (activeWorkspace) {
        return event.workspace === activeWorkspace
      }
      return event.directory === activeDirectory
    }

    // (a) Directory mode: matching directory is forwarded.
    expect(
      tuiFilter({
        event: { directory: "/proj", workspace: undefined, payload: { type: "session.next.message.created" } },
        activeWorkspace: undefined,
        activeDirectory: "/proj",
      }),
    ).toBe(true)

    // (b) Workspace mode: matching workspace is forwarded.
    expect(
      tuiFilter({
        event: { directory: "/proj", workspace: "W1", payload: { type: "session.next.message.created" } },
        activeWorkspace: "W1",
        activeDirectory: "/proj",
      }),
    ).toBe(true)

    // (c) THE BUG SHAPE FOR #26671:
    // TUI is in workspace mode, the inbound event has workspace=undefined
    // (because the session has no workspaceID and the external POST didn't
    // carry workspace context), but the directory still matches. The filter
    // bails out in the workspace branch without ever consulting directory,
    // so the event is dropped and the TUI never re-renders.
    expect(
      tuiFilter({
        event: { directory: "/proj", workspace: undefined, payload: { type: "session.next.message.created" } },
        activeWorkspace: "W1",
        activeDirectory: "/proj",
      }),
    ).toBe(false)
  })
})
