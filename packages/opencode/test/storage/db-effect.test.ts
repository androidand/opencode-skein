import { afterEach, describe, expect, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
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

  test("rebuilds a fresh handle after Database.close + runtime dispose", async () => {
    const rt1 = ManagedRuntime.make(DatabaseEffect.layer)
    const first = await rt1.runPromise(Effect.sync(() => Database.Client().$client))
    expect(first.prepare("SELECT 1 as n").get()).toEqual({ n: 1 })

    await rt1.dispose()
    Database.close()

    const rt2 = ManagedRuntime.make(DatabaseEffect.layer)
    try {
      const second = await rt2.runPromise(
        Effect.gen(function* () {
          const db = yield* DatabaseEffect.Service
          return db.$client
        }),
      )
      expect(second).not.toBe(first)
      expect(second.prepare("SELECT 1 as n").get()).toEqual({ n: 1 })
    } finally {
      await rt2.dispose()
    }
  })
})

// Regression for the memoMap lifecycle bug. The shared layer memoMap caches
// every `DatabaseEffect.layer` build across every runtime built with
// `makeManagedRuntime`. If a runtime that consumed the layer is NOT disposed
// before `Database.close()`, the cached Service value (a Drizzle wrapper
// over a now-closed `bun:sqlite` handle) persists in the memoMap and any
// subsequent runtime that consumes the layer reuses it and operates on a
// closed handle.
//
// `test/fixture/db.ts:resetDatabase` disposes every module-scoped runtime
// before closing the DB to release the memoMap entries. The two tests below
// pin both halves of the invariant.
describe("DatabaseEffect.layer + shared memoMap lifecycle", () => {
  test("disposing a runtime releases its memoMap entry so the next build sees a fresh DB handle", async () => {
    const rt1 = ManagedRuntime.make(DatabaseEffect.layer, { memoMap })
    const captured = await rt1.runPromise(Effect.sync(() => Database.Client().$client))
    expect(captured.prepare("SELECT 1 as n").get()).toEqual({ n: 1 })

    await rt1.dispose()
    Database.close()

    const rt2 = ManagedRuntime.make(DatabaseEffect.layer, { memoMap })
    try {
      const fresh = await rt2.runPromise(
        Effect.gen(function* () {
          const db = yield* DatabaseEffect.Service
          return db.$client
        }),
      )
      expect(fresh).not.toBe(captured)
      expect(fresh.prepare("SELECT 1 as n").get()).toEqual({ n: 1 })
    } finally {
      await rt2.dispose()
    }
  })

  test("a stale runtime kept alive over Database.close poisons later memoMap consumers", async () => {
    const stale = ManagedRuntime.make(DatabaseEffect.layer, { memoMap })
    const captured = await stale.runPromise(
      Effect.gen(function* () {
        const db = yield* DatabaseEffect.Service
        return db.$client
      }),
    )
    expect(captured.prepare("SELECT 1 as n").get()).toEqual({ n: 1 })

    // Intentionally do NOT dispose `stale` before closing the DB. This is
    // the shape of the bug `resetDatabase` guards against.
    Database.close()

    const next = ManagedRuntime.make(DatabaseEffect.layer, { memoMap })
    try {
      const seen = await next.runPromise(
        Effect.gen(function* () {
          const db = yield* DatabaseEffect.Service
          return db.$client
        }),
      )
      // The memoMap returned the same stale handle because `stale` was
      // never disposed. The underlying connection is closed, so any query
      // on the handle throws.
      expect(seen).toBe(captured)
      expect(() => seen.prepare("SELECT 1 as n").get()).toThrow()
    } finally {
      await next.dispose()
      await stale.dispose()
    }
  })
})
