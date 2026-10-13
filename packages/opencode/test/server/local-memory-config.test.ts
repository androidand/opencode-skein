import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

// fork: local.model.setMemory writes every memory key in ONE patch, so the
// backend reloads the model once, and never refuses against the fit estimate.

function app() {
  return Server.Default().app
}

function fakeBackend(options: { patchStatus?: number } = {}) {
  const bodies: Record<string, unknown>[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname.startsWith("/api/models/config/") && req.method === "PATCH") {
        return req.json().then((body: Record<string, unknown>) => {
          if (options.patchStatus && options.patchStatus !== 202) {
            return Response.json({ error: "model busy loading another config" }, { status: options.patchStatus })
          }
          bodies.push(body)
          return new Response(null, { status: 202 })
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    bodies,
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    [Symbol.asyncDispose]: async () => {
      await server.stop(true)
    },
  }
}

const backendEffect = (options?: Parameters<typeof fakeBackend>[0]) =>
  Effect.acquireRelease(
    Effect.sync(() => fakeBackend(options)),
    (b) => Effect.promise(() => b[Symbol.asyncDispose]()),
  )

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

function setMemory(directory: string, payload: unknown) {
  return Effect.promise(() =>
    Promise.resolve(
      app().request("/local/model/gpuhost2/qwen/memory", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-opencode-directory": directory },
        body: JSON.stringify(payload),
      }),
    ),
  )
}

const providerConfig = (baseURL: string) => ({
  formatter: false as const,
  lsp: false as const,
  provider: { gpuhost2: { npm: "@ai-sdk/openai-compatible", options: { baseURL, apiKey: "skein" } } },
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("local.model.setMemory", () => {
  it.live(
    "sends every key in a single backend patch",
    Effect.gen(function* () {
      const backend = yield* backendEffect()
      const tmp = yield* tmpdirEffect({ config: providerConfig(backend.baseURL) })
      const payload = { ctx_size: 100352, cache_type_k: "q8_0", cache_type_v: "q4_0", kv_offload: false }

      const response = yield* setMemory(tmp.path, payload)

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toBe(true)
      expect(backend.bodies).toEqual([payload])
    }),
  )

  it.live(
    "does not require ctx_size, so a cache-only change works",
    Effect.gen(function* () {
      const backend = yield* backendEffect()
      const tmp = yield* tmpdirEffect({ config: providerConfig(backend.baseURL) })

      const response = yield* setMemory(tmp.path, { cache_type_v: "q8_0" })

      expect(response.status).toBe(200)
      expect(backend.bodies).toEqual([{ cache_type_v: "q8_0" }])
    }),
  )

  it.live(
    "surfaces a backend refusal instead of reporting success",
    Effect.gen(function* () {
      const backend = yield* backendEffect({ patchStatus: 409 })
      const tmp = yield* tmpdirEffect({ config: providerConfig(backend.baseURL) })

      const response = yield* setMemory(tmp.path, { ctx_size: 100352 })

      expect(response.status).toBeGreaterThanOrEqual(500)
      expect(backend.bodies).toEqual([])
    }),
  )
})
