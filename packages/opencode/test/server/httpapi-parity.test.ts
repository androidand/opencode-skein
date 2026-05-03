import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { WithInstance } from "../../src/project/with-instance"
import { Server } from "../../src/server/server"
import { Session } from "@/session/session"
import { MessageID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

function app(experimental: boolean) {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = experimental
  return experimental ? Server.Default().app : Server.Legacy().app
}

function runSession<A, E>(fx: Effect.Effect<A, E, Session.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Session.defaultLayer)))
}

function createSessionWithMessages(directory: string, count: number) {
  return WithInstance.provide({
    directory,
    fn: () =>
      runSession(
        Effect.gen(function* () {
          const svc = yield* Session.Service
          const session = yield* svc.create({})
          for (let i = 0; i < count; i++) {
            yield* svc.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
              time: { created: Date.now() },
            })
          }
          return session.id
        }),
      ),
  })
}

// ──────────────────────────────────────────────────────────────────────────────
// Reproducer 1: Link header should reflect the request's actual Host header,
// not "localhost". HttpApi uses `new URL(request.url, "http://localhost")`
// which embeds localhost because request.url is path-only. Fix: use
// `HttpServerRequest.toURL(request)` which honors the Host header.
// ──────────────────────────────────────────────────────────────────────────────
describe("Link header host", () => {
  test("HttpApi pagination Link header echoes request host", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const sessionID = await createSessionWithMessages(tmp.path, 3)

    const response = await app(true).request(`/session/${sessionID}/message?limit=2`, {
      headers: {
        host: "opencode.test:4096",
        "x-opencode-directory": tmp.path,
      },
    })

    expect(response.status).toBe(200)
    const link = response.headers.get("link")
    expect(link).not.toBeNull()
    // Link should contain the request's Host, not "localhost".
    expect(link).toContain("opencode.test")
    expect(link).not.toContain("localhost")
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Reproducer 2: GET /session/{missing-id}/todo returns 404, not 500.
// Previously the session.todo handler didn't wrap with `mapNotFound`, so a
// thrown `NotFoundError` surfaced as a defect → 500. Hono's equivalent maps
// to 404 via `errors.notFound`. mapNotFound is now applied to all session
// endpoints that take a sessionID.
// ──────────────────────────────────────────────────────────────────────────────
describe("404 mapping for missing session", () => {
  test("HttpApi /session/{missing}/fork returns 404 not 500", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })

    const response = await app(true).request("/session/ses_does_not_exist/fork", {
      method: "POST",
      headers: {
        "x-opencode-directory": tmp.path,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(404)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Reproducer 3: 404 body matches Hono's NamedError envelope
// `{ name: "NotFoundError", data: { message } }`. HttpApi previously returned
// `{ _tag: "NotFound" }` (empty body via HttpApiError.NotFound). The new
// OpencodeNotFound class encodes the legacy shape via its schema fields and
// `httpApiStatus: 404` annotation.
// ──────────────────────────────────────────────────────────────────────────────
describe("Error JSON shape parity", () => {
  test("HttpApi 404 body matches NamedError shape", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })

    const response = await app(true).request("/session/ses_does_not_exist", {
      headers: { "x-opencode-directory": tmp.path },
    })

    expect(response.status).toBe(404)
    const body = (await response.json()) as { name?: string; data?: { message?: string } }
    expect(body.name).toBe("NotFoundError")
    expect(typeof body.data?.message).toBe("string")
  })
})
