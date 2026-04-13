import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { GlobalBus } from "../../src/bus/global"
import { registerAdaptor } from "../../src/control-plane/adaptors"
import type { WorkspaceAdaptor } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { Flag } from "../../src/flag/flag"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Database, asc, eq } from "../../src/storage/db"
import { SyncEvent } from "../../src/sync"
import { EventTable } from "../../src/sync/event.sql"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES

beforeEach(() => {
  Database.close()
  // @ts-expect-error test override
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
})

afterEach(async () => {
  mock.restore()
  // @ts-expect-error test override
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = original
  await resetDatabase()
})

async function user(sessionID: SessionID, text: string) {
  const msg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: msg.id,
    type: "text",
    text,
  })
}

function remote(dir: string, url: string): WorkspaceAdaptor {
  return {
    name: "remote",
    description: "remote",
    configure(info) {
      return {
        ...info,
        directory: dir,
      }
    },
    async create() {
      await fs.mkdir(dir, { recursive: true })
    },
    async remove() {},
    target() {
      return {
        type: "remote" as const,
        url,
      }
    },
  }
}

function local(dir: string): WorkspaceAdaptor {
  return {
    name: "local",
    description: "local",
    configure(info) {
      return {
        ...info,
        directory: dir,
      }
    },
    async create() {
      await fs.mkdir(dir, { recursive: true })
    },
    async remove() {},
    target() {
      return {
        type: "local" as const,
        directory: dir,
      }
    },
  }
}

describe("workspace restore route", () => {
  test("replays session events in batches of 10 and emits progress", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default().app
    const dir = path.join(tmp.path, ".restore")
    const seen: any[] = []
    const posts: Array<{
      path: string
      body: { directory: string; events: Array<{ seq: number; aggregateID: string }> }
    }> = []
    const on = (evt: any) => seen.push(evt)
    GlobalBus.on("event", on)

    const raw = globalThis.fetch
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: URL | RequestInfo, init?: BunFetchRequestInit | RequestInit) => {
          const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
          posts.push({
            path: url.pathname,
            body: JSON.parse(String(init?.body)),
          })
          return Response.json({ sessionID: posts.at(-1)!.body.events[0].aggregateID })
        },
        {
          preconnect: raw.preconnect?.bind(raw),
        },
      ) as typeof globalThis.fetch,
    )

    try {
      const setup = await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          registerAdaptor(Instance.project.id, "worktree", remote(dir, "https://workspace.test/base"))
          const space = await Workspace.create({
            type: "worktree",
            branch: null,
            extra: null,
            projectID: Instance.project.id,
          })
          const session = await Session.create({})
          for (let i = 0; i < 6; i++) {
            await user(session.id, `msg ${i}`)
          }
          const rows = Database.use((db) =>
            db
              .select({ seq: EventTable.seq })
              .from(EventTable)
              .where(eq(EventTable.aggregate_id, session.id))
              .orderBy(asc(EventTable.seq))
              .all(),
          )
          return { space, session, rows }
        },
      })

      expect(setup.rows).toHaveLength(13)

      const res = await app.request(`/experimental/workspace/${setup.space.id}/session-restore`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          sessionID: setup.session.id,
        }),
      })

      expect(fetch).toHaveBeenCalledTimes(2)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ total: 2 })
      expect(posts).toHaveLength(2)
      expect(posts[0]?.path).toBe("/base/sync/replay")
      expect(posts[1]?.path).toBe("/base/sync/replay")
      expect(posts[0]?.body.directory).toBe(dir)
      expect(posts[1]?.body.directory).toBe(dir)
      expect(posts[0]?.body.events).toHaveLength(10)
      expect(posts[1]?.body.events).toHaveLength(4)
      expect(posts.flatMap((item) => item.body.events.map((event) => event.seq))).toEqual([
        ...setup.rows.map((row) => row.seq),
        setup.rows.at(-1)!.seq + 1,
      ])
      expect(posts[1]?.body.events.at(-1)).toMatchObject({
        aggregateID: setup.session.id,
        seq: setup.rows.at(-1)!.seq + 1,
        type: SyncEvent.versionedType(Session.Event.Updated.type, Session.Event.Updated.version),
        data: {
          sessionID: setup.session.id,
          info: {
            workspaceID: setup.space.id,
          },
        },
      })

      const restore = seen.filter(
        (evt) => evt.workspace === setup.space.id && evt.payload.type === Workspace.Event.Restore.type,
      )
      expect(restore.map((evt) => evt.payload.properties.step)).toEqual([0, 1, 2])
      expect(restore.map((evt) => evt.payload.properties.total)).toEqual([2, 2, 2])
      expect(restore.map((evt) => evt.payload.properties.sessionID)).toEqual([
        setup.session.id,
        setup.session.id,
        setup.session.id,
      ])
    } finally {
      GlobalBus.off("event", on)
    }
  })

  test("replays locally without posting to a server", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default().app
    const dir = path.join(tmp.path, ".restore-local")
    const seen: any[] = []
    const on = (evt: any) => seen.push(evt)
    GlobalBus.on("event", on)

    const fetch = spyOn(globalThis, "fetch")
    const replayAll = spyOn(SyncEvent, "replayAll")

    try {
      const setup = await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          registerAdaptor(Instance.project.id, "local-restore", local(dir))
          const space = await Workspace.create({
            type: "local-restore",
            branch: null,
            extra: null,
            projectID: Instance.project.id,
          })
          const session = await Session.create({})
          for (let i = 0; i < 6; i++) {
            await user(session.id, `msg ${i}`)
          }
          return { space, session }
        },
      })

      const res = await app.request(`/experimental/workspace/${setup.space.id}/session-restore`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({
          sessionID: setup.session.id,
        }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ total: 2 })
      expect(fetch).not.toHaveBeenCalled()
      expect(replayAll).toHaveBeenCalledTimes(2)
      expect((await Session.get(setup.session.id)).workspaceID).toBe(setup.space.id)

      const restore = seen.filter(
        (evt) => evt.workspace === setup.space.id && evt.payload.type === Workspace.Event.Restore.type,
      )
      expect(restore.map((evt) => evt.payload.properties.step)).toEqual([0, 1, 2])
    } finally {
      GlobalBus.off("event", on)
    }
  })
})
