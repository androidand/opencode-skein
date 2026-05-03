import type { Context } from "hono"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { NotFoundError } from "@/storage/storage"
import { Session } from "@/session/session"

type AppEnv = Parameters<typeof AppRuntime.runPromise>[0] extends Effect.Effect<any, any, infer R> ? R : never

// Build the base span attributes for an HTTP handler: method, path, and every
// matched route param. Names follow OTel attribute-naming guidance:
// domain-first (`session.id`, `message.id`, …) so they match the existing
// OTel `session.id` semantic convention and the bare `message.id` we
// already emit from Tool.execute. Non-standard route params fall back to
// `opencode.<name>` since those are internal implementation details
// (per https://opentelemetry.io/blog/2025/how-to-name-your-span-attributes/).
export interface RequestLike {
  readonly req: {
    readonly method: string
    readonly url: string
    param(): Record<string, string>
  }
}

// Normalize a Hono route param key (e.g. `sessionID`, `messageID`, `name`)
// to an OTel attribute key. `fooID` → `foo.id` for ID-shaped params; any
// other param is namespaced under `opencode.` to avoid colliding with
// standard conventions.
export function paramToAttributeKey(key: string): string {
  const m = key.match(/^(.+)ID$/)
  if (m) return `${m[1].toLowerCase()}.id`
  return `opencode.${key}`
}

export function requestAttributes(c: RequestLike): Record<string, string> {
  const attributes: Record<string, string> = {
    "http.method": c.req.method,
    "http.path": new URL(c.req.url).pathname,
  }
  for (const [key, value] of Object.entries(c.req.param())) {
    attributes[paramToAttributeKey(key)] = value
  }
  return attributes
}

// Bridge typed service errors to the legacy Hono `NamedError` ErrorMiddleware.
// The HttpApi adapter consumes typed errors directly via schema annotations,
// but Hono's ErrorMiddleware switches on `instanceof NamedError`. Until the
// legacy adapter is retired, catch the new typed errors here and rethrow the
// equivalent NamedError so the existing 404 wiring keeps working.
const adaptTypedErrors = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, Session.SessionNotFound>, R> =>
  self.pipe(
    Effect.catchIf(
      (e: unknown) => e instanceof Session.SessionNotFound,
      (e) => Effect.die(new NotFoundError({ message: (e as Session.SessionNotFound).data.message })),
    ),
  ) as unknown as Effect.Effect<A, Exclude<E, Session.SessionNotFound>, R>

export function runRequest<A, E>(name: string, c: Context, effect: Effect.Effect<A, E, AppEnv>) {
  return AppRuntime.runPromise(
    adaptTypedErrors(effect).pipe(Effect.withSpan(name, { attributes: requestAttributes(c) })),
  )
}

export async function jsonRequest<C extends Context, A, E>(
  name: string,
  c: C,
  effect: (c: C) => Effect.gen.Return<A, E, AppEnv>,
) {
  return c.json(
    await runRequest(
      name,
      c,
      Effect.gen(() => effect(c)),
    ),
  )
}
