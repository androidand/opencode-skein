import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Effect, Schema } from "effect"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { SyncEvent } from "../../src/sync"
import { Database } from "@/storage/db"
import { EventTable } from "../../src/sync/event.sql"
import { Identifier } from "../../src/id/id"
import { Flag } from "@opencode-ai/core/flag/flag"
import { initProjectors } from "../../src/server/projectors"

const original = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES

beforeEach(() => {
  Database.close()

  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
})

afterEach(() => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = original
})

function withInstance(fn: () => void | Promise<void>) {
  return async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await fn()
      },
    })
  }
}

function runSyncEvent<A>(fn: (sync: SyncEvent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(SyncEvent.Service.use(fn).pipe(Effect.provide(SyncEvent.defaultLayer)))
}

async function expectRejects(input: Promise<unknown>, pattern: RegExp) {
  try {
    await input
  } catch (error) {
    if (!(error instanceof Error)) throw error
    expect(error.message).toMatch(pattern)
    return
  }
  throw new Error("Expected promise to reject")
}

describe("SyncEvent", () => {
  function setup() {
    SyncEvent.reset()

    const Created = SyncEvent.define({
      type: "item.created",
      version: 1,
      aggregate: "id",
      schema: Schema.Struct({ id: Schema.String, name: Schema.String }),
    })
    const Sent = SyncEvent.define({
      type: "item.sent",
      version: 1,
      aggregate: "item_id",
      schema: Schema.Struct({ item_id: Schema.String, to: Schema.String }),
    })

    SyncEvent.init({
      projectors: [SyncEvent.project(Created, () => {}), SyncEvent.project(Sent, () => {})],
    })

    return { Created, Sent }
  }

  afterAll(() => {
    SyncEvent.reset()
    initProjectors()
  })

  describe("run", () => {
    test(
      "inserts event row",
      withInstance(async () => {
        const { Created } = setup()
        await runSyncEvent((sync) => sync.run(Created, { id: "evt_1", name: "first" }))
        const rows = Database.use((db) => db.select().from(EventTable).all())
        expect(rows).toHaveLength(1)
        expect(rows[0].type).toBe("item.created.1")
        expect(rows[0].aggregate_id).toBe("evt_1")
      }),
    )

    test(
      "increments seq per aggregate",
      withInstance(async () => {
        const { Created } = setup()
        await runSyncEvent((sync) => sync.run(Created, { id: "evt_1", name: "first" }))
        await runSyncEvent((sync) => sync.run(Created, { id: "evt_1", name: "second" }))
        const rows = Database.use((db) => db.select().from(EventTable).all())
        expect(rows).toHaveLength(2)
        expect(rows[1].seq).toBe(rows[0].seq + 1)
      }),
    )

    test(
      "uses custom aggregate field from agg()",
      withInstance(async () => {
        const { Sent } = setup()
        await runSyncEvent((sync) => sync.run(Sent, { item_id: "evt_1", to: "james" }))
        const rows = Database.use((db) => db.select().from(EventTable).all())
        expect(rows).toHaveLength(1)
        expect(rows[0].aggregate_id).toBe("evt_1")
      }),
    )

    test(
      "emits events",
      withInstance(async () => {
        const { Created } = setup()
        const events: Array<{
          type: string
          properties: { id: string; name: string }
        }> = []
        const received = new Promise<void>((resolve) => {
          Bus.subscribeAll((event) => {
            events.push(event)
            resolve()
          })
        })

        await runSyncEvent((sync) => sync.run(Created, { id: "evt_1", name: "test" }))

        await received
        expect(events).toHaveLength(1)
        expect(events[0]).toEqual({
          type: "item.created",
          properties: {
            id: "evt_1",
            name: "test",
          },
        })
      }),
    )
  })

  describe("replay", () => {
    test(
      "inserts event from external payload",
      withInstance(async () => {
        const id = Identifier.descending("message")
        await runSyncEvent((sync) =>
          sync.replay({
            id: "evt_1",
            type: "item.created.1",
            seq: 0,
            aggregateID: id,
            data: { id, name: "replayed" },
          }),
        )
        const rows = Database.use((db) => db.select().from(EventTable).all())
        expect(rows).toHaveLength(1)
        expect(rows[0].aggregate_id).toBe(id)
      }),
    )

    test(
      "throws on sequence mismatch",
      withInstance(async () => {
        const id = Identifier.descending("message")
        await runSyncEvent((sync) =>
          sync.replay({
            id: "evt_1",
            type: "item.created.1",
            seq: 0,
            aggregateID: id,
            data: { id, name: "first" },
          }),
        )
        await expectRejects(
          runSyncEvent((sync) =>
            sync.replay({
              id: "evt_1",
              type: "item.created.1",
              seq: 5,
              aggregateID: id,
              data: { id, name: "bad" },
            }),
          ),
          /Sequence mismatch/,
        )
      }),
    )

    test(
      "throws on unknown event type",
      withInstance(async () => {
        await expectRejects(
          runSyncEvent((sync) =>
            sync.replay({
              id: "evt_1",
              type: "unknown.event.1",
              seq: 0,
              aggregateID: "x",
              data: {},
            }),
          ),
          /Unknown event type/,
        )
      }),
    )

    test(
      "replayAll accepts later chunks after the first batch",
      withInstance(async () => {
        const { Created } = setup()
        const id = Identifier.descending("message")

        const one = await runSyncEvent((sync) =>
          sync.replayAll([
            {
              id: "evt_1",
              type: SyncEvent.versionedType(Created.type, Created.version),
              seq: 0,
              aggregateID: id,
              data: { id, name: "first" },
            },
            {
              id: "evt_2",
              type: SyncEvent.versionedType(Created.type, Created.version),
              seq: 1,
              aggregateID: id,
              data: { id, name: "second" },
            },
          ]),
        )

        const two = await runSyncEvent((sync) =>
          sync.replayAll([
            {
              id: "evt_3",
              type: SyncEvent.versionedType(Created.type, Created.version),
              seq: 2,
              aggregateID: id,
              data: { id, name: "third" },
            },
            {
              id: "evt_4",
              type: SyncEvent.versionedType(Created.type, Created.version),
              seq: 3,
              aggregateID: id,
              data: { id, name: "fourth" },
            },
          ]),
        )

        expect(one).toBe(id)
        expect(two).toBe(id)

        const rows = Database.use((db) => db.select().from(EventTable).all())
        expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3])
      }),
    )
  })
})
