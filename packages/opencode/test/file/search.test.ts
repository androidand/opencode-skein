import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect, Layer } from "effect"
import { Fff } from "#fff"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Search } from "../../src/file/search"
import { Global } from "@opencode-ai/core/global"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(Search.defaultLayer, CrossSpawnSpawner.defaultLayer))

function db(dir: string) {
  const id = Buffer.from(AppFileSystem.resolve(dir)).toString("base64url")
  return {
    frecency: path.join(Global.Path.cache, "fff", `${id}.frecency.mdb`),
    history: path.join(Global.Path.cache, "fff", `${id}.history.mdb`),
  }
}

describe("file.search", () => {
  it.live("uses fff for Bun-backed grep", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        expect(Fff.available()).toBe(true)
        yield* Effect.promise(() => Bun.write(path.join(dir, "src", "match.ts"), "const needle = 1\n"))

        const search = yield* Search.Service
        const result = yield* search.search({ cwd: dir, pattern: "needle", limit: 10 })

        expect(result.engine).toBe("fff")
        expect(result.items).toHaveLength(1)
        expect(result.items[0]?.path.text).toBe("src/match.ts")
      }),
    ),
  )

  it.live("records query history when a searched file is opened", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        expect(Fff.available()).toBe(true)
        yield* Effect.promise(() => Bun.write(path.join(dir, "alpha-target-one.ts"), "export const one = 1\n"))
        yield* Effect.promise(() => Bun.write(path.join(dir, "alpha-target-two.ts"), "export const two = 2\n"))

        const search = yield* Search.Service
        const results = yield* search.file({ cwd: dir, query: "alpha target two", limit: 10 })

        expect(results).toContain("alpha-target-two.ts")

        yield* search.open({ cwd: dir, file: "alpha-target-two.ts" })
        yield* Effect.promise(() => Instance.disposeAll())

        const picker = Fff.create({
          basePath: dir,
          frecencyDbPath: db(dir).frecency,
          historyDbPath: db(dir).history,
          aiMode: true,
        })
        expect(picker.ok).toBe(true)
        if (!picker.ok) return

        const history = picker.value.getHistoricalQuery(0)
        picker.value.destroy()

        expect(history.ok).toBe(true)
        if (!history.ok) return
        expect(history.value).toBe("alpha target two")
      }),
    ),
  )
})
