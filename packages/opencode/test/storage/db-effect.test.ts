import { afterEach, describe, expect, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import { Database } from "@/storage/db"
import { DatabaseEffect } from "@/storage/db-effect"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await resetDatabase()
})

describe("DatabaseEffect.layer", () => {
  test("yields a working Service that round-trips a query", async () => {
    const rt = ManagedRuntime.make(DatabaseEffect.layer)
    try {
      const value = await rt.runPromise(
        Effect.gen(function* () {
          const db = yield* DatabaseEffect.Service
          return db.$client.prepare("SELECT 42 as n").get() as { n: number }
        }),
      )
      expect(value).toEqual({ n: 42 })
    } finally {
      await rt.dispose()
    }
  })

  test("service resolves a fresh handle after Database.close", async () => {
    const rt = ManagedRuntime.make(DatabaseEffect.layer)
    const first = await rt.runPromise(Effect.sync(() => Database.Client().$client))
    expect(first.prepare("SELECT 1 as n").get()).toEqual({ n: 1 })

    Database.close()

    try {
      const second = await rt.runPromise(
        Effect.gen(function* () {
          const db = yield* DatabaseEffect.Service
          return db.$client
        }),
      )
      expect(second).not.toBe(first)
      expect(second.prepare("SELECT 1 as n").get()).toEqual({ n: 1 })
    } finally {
      await rt.dispose()
    }
  })

  test("a runtime kept alive over Database.close uses the refreshed handle", async () => {
    const rt = ManagedRuntime.make(DatabaseEffect.layer)
    const captured = await rt.runPromise(
      Effect.gen(function* () {
        const db = yield* DatabaseEffect.Service
        return db.$client
      }),
    )
    expect(captured.prepare("SELECT 1 as n").get()).toEqual({ n: 1 })

    Database.close()

    try {
      const fresh = await rt.runPromise(
        Effect.gen(function* () {
          const db = yield* DatabaseEffect.Service
          return db.$client
        }),
      )
      expect(fresh).not.toBe(captured)
      expect(fresh.prepare("SELECT 1 as n").get()).toEqual({ n: 1 })
    } finally {
      await rt.dispose()
    }
  })
})
