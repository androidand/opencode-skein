/**
 * Reproducer for #26435 — `session list` crashes when the DB contains
 * a legacy-shape `model` column.
 *
 * On 2026-05-02 #24512 renamed the JSON shape stored in `session.model`
 * from `{ providerID, modelID }` to `{ id, providerID, variant }`.
 * The Drizzle column type was updated but no data migration rewrote
 * existing rows. `fromRow` now reads `row.model.id`; on legacy rows
 * that field is undefined and `ModelID.make(undefined)` throws,
 * killing the entire list (no per-row containment).
 */
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@/storage/db"
import { Session as SessionNs } from "@/session/session"
import { SessionTable } from "@/session/session.sql"
import { WithInstance } from "@/project/with-instance"
import * as Log from "@opencode-ai/core/util/log"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, CrossSpawnSpawner.defaultLayer))

afterEach(async () => {
  await disposeAllInstances()
})

describe("session list with legacy model shape (#26435)", () => {
  it.live("does not crash when a row has the pre-#24512 {providerID, modelID} shape", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true, config: { formatter: false, lsp: false } })),
        (t) => Effect.promise(() => t[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() =>
        WithInstance.provide({
          directory: tmp.path,
          fn: async () => {
            const svc = SessionNs.Service
            // Create two valid sessions so we can prove the list still
            // returns the good ones after the legacy row is patched.
            const legacy = await Effect.runPromise(
              Effect.provide(svc.use((s) => s.create({ title: "legacy" })), SessionNs.defaultLayer),
            )
            const ok = await Effect.runPromise(
              Effect.provide(svc.use((s) => s.create({ title: "ok" })), SessionNs.defaultLayer),
            )

            // Replace the legacy row's model JSON with the pre-#24512
            // shape that's still on disk for users who upgraded.
            Database.use((db) =>
              db
                .update(SessionTable)
                .set({ model: { providerID: "opencode", modelID: "big-pickle" } as any })
                .where(eq(SessionTable.id, legacy.id))
                .run(),
            )

            // Pre-fix this throws inside `fromRow` and the whole list
            // call rejects, hiding `ok` along with `legacy`.
            const list = await Effect.runPromise(
              Effect.provide(svc.use((s) => s.list()), SessionNs.defaultLayer),
            )
            const ids = list.map((s) => s.id)
            expect(ids).toContain(ok.id)
            expect(ids).toContain(legacy.id)

            const legacyEntry = list.find((s) => s.id === legacy.id)!
            // Post-fix the legacy row resolves cleanly with the
            // recovered modelID surfaced as `id`.
            expect(legacyEntry.model?.id).toBe("big-pickle")
            expect(legacyEntry.model?.providerID).toBe("opencode")
          },
        }),
      )
    }),
  )
})
