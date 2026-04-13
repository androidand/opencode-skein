import z from "zod"
import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { SyncEvent } from "@/sync"
import { Database, asc, and, not, or, lte, eq } from "@/storage/db"
import { EventTable } from "@/sync/event.sql"
import { Log } from "@/util/log"
import { lazy } from "@/util/lazy"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "../../project/bootstrap"
import { errors } from "../error"
import { streamQueue } from "../stream-queue"

const log = Log.create({ service: "server" })

const ReplayEvent = z.object({
  id: z.string(),
  aggregateID: z.string(),
  seq: z.number().int().min(0),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
})

export const SyncRoutes = lazy(() =>
  new Hono()
    .get(
      "/event",
      describeRoute({
        summary: "Subscribe to sync events",
        description: "Get sync events",
        operationId: "sync.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      payload: SyncEvent.payloads(),
                    })
                    .meta({
                      ref: "SyncEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("sync event connected")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")
        return streamQueue(c, {
          connect: (q) => {
            log.info("sync event connected")

            q.push(
              JSON.stringify({
                type: "server.connected",
                properties: {},
              }),
            )
          },
          heartbeat: (q) => {
            q.push(
              JSON.stringify({
                type: "server.heartbeat",
                properties: {},
              }),
            )
          },

          subscribe: (q) => {
            const unsub = SyncEvent.subscribeAll(({ def, event }) => {
              q.push(JSON.stringify({ ...event, type: SyncEvent.versionedType(def.type, def.version) }))
            })

            return () => {
              unsub()
              log.info("sync event disconnected")
            }
          },
        })
      },
    )
    .post(
      "/replay",
      describeRoute({
        summary: "Replay sync events",
        description: "Validate and replay a complete sync event history.",
        operationId: "global.sync-replay",
        responses: {
          200: {
            description: "Replayed sync events",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    sessionID: z.string(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          directory: z.string(),
          events: z.array(ReplayEvent).min(1),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const events = body.events
        const source = events[0].aggregateID
        if (events.some((item) => item.aggregateID !== source)) {
          throw new Error("Replay events must belong to the same session")
        }
        for (const [i, item] of events.entries()) {
          if (item.seq !== i) throw new Error(`Replay sequence mismatch at index ${i}: expected ${i}, got ${item.seq}`)
        }

        return Instance.provide({
          directory: body.directory,
          init: InstanceBootstrap,
          async fn() {
            for (const item of events) {
              SyncEvent.replay(item)
            }
            return c.json({ sessionID: source })
          },
        })
      },
    )
    .get(
      "/history",
      describeRoute({
        summary: "List sync events",
        description: "List sync events for all aggregates. Keys are aggregate IDs the client already knows about, values are the last known sequence ID. Events with seq > value are returned for those aggregates. Aggregates not listed in the input get their full history.",
        operationId: "global.sync-history.list",
        responses: {
          200: {
            description: "Sync events",
            content: {
              "application/json": {
                schema: resolver(
                  z.array(
                    z.object({
                      id: z.string(),
                      aggregate_id: z.string(),
                      seq: z.number(),
                      type: z.string(),
                      data: z.record(z.string(), z.unknown()),
                    }),
                  ),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.record(z.string(), z.number().int().min(0)),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const exclude = Object.entries(body)
        const where = exclude.length > 0
          ? not(or(...exclude.map(([id, seq]) => and(eq(EventTable.aggregate_id, id), lte(EventTable.seq, seq))))!)
          : undefined
        const rows = Database.use((db) =>
          db
            .select()
            .from(EventTable)
            .where(where)
            .orderBy(asc(EventTable.seq))
            .all(),
        )
        return c.json(rows)
      },
    ),
)
