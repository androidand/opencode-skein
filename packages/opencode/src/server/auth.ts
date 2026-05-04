export * as ServerAuth from "./auth"

import { ConfigService } from "@/effect/config-service"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Config as EffectConfig, Context, Layer, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

// Read auth config from `Flag.*` instead of via Effect's `Config` system.
// Effect's generated `defaultLayer` reads `Config.string(...)` once and is
// memoized by `Layer` identity, so subsequent runtime mutation of
// `process.env` is never observed by the resolved layer. Tests and dynamic
// deploys mutate `Flag.OPENCODE_SERVER_*` at runtime; matching Hono's
// behavior requires re-reading `Flag.*` whenever a fresh listener (i.e. a
// fresh `memoMap`) is built. `Layer.sync` defers the read until layer-build
// time, so each new listener picks up the current `Flag.*` values.
//
// Note: this is per-listener, not per-request. Hono's `AuthMiddleware` reads
// `Flag.*` on every request; if exact per-request parity is ever required,
// the middleware itself must read `Flag.*` rather than yielding `Config`.
export class Config extends ConfigService.Service<Config>()("@opencode/ServerAuthConfig", {
  password: EffectConfig.string("OPENCODE_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("OPENCODE_SERVER_USERNAME").pipe(EffectConfig.withDefault("opencode")),
}) {
  static override get defaultLayer() {
    return Layer.sync(this, () =>
      this.of({
        password: Flag.OPENCODE_SERVER_PASSWORD ? Option.some(Flag.OPENCODE_SERVER_PASSWORD) : Option.none(),
        username: Flag.OPENCODE_SERVER_USERNAME ?? "opencode",
      }),
    )
  }
}

export type Info = Context.Service.Shape<typeof Config>

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
