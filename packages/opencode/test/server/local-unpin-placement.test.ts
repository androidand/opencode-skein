import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

// fork: the ctx dialog's "allow offload" action goes through
// local.model.setOffload with `unpin_placement`. The server route must pass it
// through to llama-skein's config PATCH verbatim — the planner, not this
// client, decides what placement results.

function app() {
  return Server.Default().app
}

function fakeBackend() {
  const bodies: Array<Record<string, unknown>> = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname.startsWith("/api/models/config/") && req.method === "PATCH") {
        return req.json().then((body: Record<string, unknown>) => {
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
    stop: () => server.stop(true),
  }
}

const backendEffect = () =>
  Effect.acquireRelease(
    Effect.sync(fakeBackend),
    (b) => Effect.promise(() => b.stop()),
  )

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("local.model.setOffload unpin_placement", () => {
  it.live(
    "forwards unpin_placement to llama-skein's config patch",
    Effect.gen(function* () {
      const backend = yield* backendEffect()
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false as const,
          lsp: false as const,
          provider: { gpuhost2: { npm: "@ai-sdk/openai-compatible", options: { baseURL: backend.baseURL, apiKey: "skein" } } },
        },
      })
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/local/model/gpuhost2/big-dense/offload", {
            method: "PATCH",
            headers: { "content-type": "application/json", "x-opencode-directory": tmp.path },
            body: JSON.stringify({ unpin_placement: true }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toBe(true)
      expect(backend.bodies).toEqual([{ unpin_placement: true }])
    }),
  )

  it.live(
    "forwards an explicit n_gpu_layers, including 0, verbatim",
    Effect.gen(function* () {
      const backend = yield* backendEffect()
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false as const,
          lsp: false as const,
          provider: { gpuhost2: { npm: "@ai-sdk/openai-compatible", options: { baseURL: backend.baseURL, apiKey: "skein" } } },
        },
      })
      for (const n of [99, 0]) {
        const response = yield* Effect.promise(() =>
          Promise.resolve(
            app().request("/local/model/gpuhost2/big-dense/offload", {
              method: "PATCH",
              headers: { "content-type": "application/json", "x-opencode-directory": tmp.path },
              body: JSON.stringify({ n_gpu_layers: n }),
            }),
          ),
        )
        expect(response.status).toBe(200)
      }
      // 0 is a real value (all layers on the CPU); it must not be dropped or turned into a removal.
      expect(backend.bodies).toEqual([{ n_gpu_layers: 99 }, { n_gpu_layers: 0 }])
    }),
  )
})
