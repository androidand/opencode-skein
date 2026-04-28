import { Database } from "@/storage/db"
import * as StorageSchema from "@/storage/schema"
import { Context, Layer } from "effect"
import { drizzle, type EffectSQLiteDatabase } from "@opencode-ai/effect-drizzle-sqlite"

const schema = { ...StorageSchema }

export class Service extends Context.Service<Service, EffectSQLiteDatabase<typeof schema>>()("@opencode/DatabaseEffect") {}

export const layer = Layer.sync(Service, () => {
  let current: EffectSQLiteDatabase<typeof schema> | undefined

  return new Proxy({} as EffectSQLiteDatabase<typeof schema>, {
    get(_target, property) {
      const client = Database.Client().$client
      if (current?.$client !== client) current = drizzle({ client, schema })

      const value = Reflect.get(current, property)
      return typeof value === "function" ? value.bind(current) : value
    },
  })
})

export * as DatabaseEffect from "./db-effect"
