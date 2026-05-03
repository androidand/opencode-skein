import { Database } from "@/storage/db"
import { Context, Layer } from "effect"
import type { EffectSQLiteDatabase } from "@opencode-ai/effect-drizzle-sqlite"
import * as StorageSchema from "@/storage/schema"

export class Service extends Context.Service<Service, EffectSQLiteDatabase<typeof StorageSchema>>()(
  "@opencode/DatabaseEffect",
) {}

const client = new Proxy({} as EffectSQLiteDatabase<typeof StorageSchema>, {
  get(_target, property) {
    const db = Database.Client()
    const value = Reflect.get(db, property)
    return typeof value === "function" ? value.bind(db) : value
  },
})

export const layer = Layer.succeed(Service, client)

export * as DatabaseEffect from "./db-effect"
