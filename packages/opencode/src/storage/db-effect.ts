import { Database } from "@/storage/db"
import * as StorageSchema from "@/storage/schema"
import { Context, Effect, Layer } from "effect"
import { drizzle, type EffectSQLiteDatabase } from "@opencode-ai/effect-drizzle-sqlite"

const schema = { ...StorageSchema }

export class Service extends Context.Service<Service, EffectSQLiteDatabase<typeof schema>>()("@opencode/DatabaseEffect") {}

export const layer = Layer.effect(
  Service,
  Effect.acquireRelease(
    Effect.sync(() => {
      const lease = Database.acquire()
      return { lease, db: drizzle({ client: lease.client.$client, schema }) }
    }),
    (value) => Effect.sync(() => value.lease.release()),
  ).pipe(Effect.map((value) => value.db)),
)

export * as DatabaseEffect from "./db-effect"
