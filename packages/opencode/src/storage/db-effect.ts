import { Database } from "@/storage/db"
import { Context, Effect, Layer } from "effect"
import type { EffectSQLiteDatabase } from "@opencode-ai/effect-drizzle-sqlite"
import * as StorageSchema from "@/storage/schema"

// Thin Effect Service over the module-global `Database.Client` lazy. The DB
// lifecycle is owned by `Database.open` / `Database.close`, not by this
// layer. Any runtime (see `effect/managed-runtime.ts`) that consumes this
// layer through the shared layer memoMap must be disposed before
// `Database.close()` so its memoized Service value does not outlive the
// underlying SQLite handle. See `test/fixture/db.ts:resetDatabase`.
export class Service extends Context.Service<Service, EffectSQLiteDatabase<typeof StorageSchema>>()(
  "@opencode/DatabaseEffect",
) {}

export const layer = Layer.effect(Service, Effect.sync(Database.Client))

export * as DatabaseEffect from "./db-effect"
