export * as ServiceManager from "."

import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Context, Effect, Layer } from "effect"
import * as ServiceLinux from "./linux"
import * as ServiceMacos from "./macos"
import * as ServicePlatform from "./platform"
import {
  chmodFile,
  CONFIG_FILE,
  generatePassword,
  type InstallInput,
  type InstallResult,
  readStoredConfig,
  resolveServeCommand,
  ServiceError,
  writeJsonFile,
} from "./shared"
import * as ServiceUnsupported from "./unsupported"
import * as ServiceWindows from "./windows"

export interface Interface {
  readonly install: (input: InstallInput) => Effect.Effect<InstallResult, ServiceError>
  readonly password: () => Effect.Effect<string, ServiceError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ServiceManager") {}

const platformLayer =
  process.platform === "linux"
    ? ServiceLinux.layer
    : process.platform === "darwin"
      ? ServiceMacos.layer
      : process.platform === "win32"
        ? ServiceWindows.layer
        : ServiceUnsupported.layer

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const platform = yield* ServicePlatform.Service

    const install = Effect.fn("ServiceManager.install")(function* (input: InstallInput) {
      const stored = yield* readStoredConfig(fs)
      const password =
        input.password ?? process.env.OPENCODE_PASSWORD ?? process.env.OPENCODE_SERVER_PASSWORD ?? stored?.password ?? generatePassword()
      const hostname = input.hostname ?? stored?.hostname ?? "127.0.0.1"

      yield* writeJsonFile(fs, CONFIG_FILE, { password, hostname }, 0o600)
      yield* chmodFile(fs, CONFIG_FILE, 0o600).pipe(Effect.catch(() => Effect.void))

      const result = yield* platform.install({
        password,
        hostname,
        command: yield* resolveServeCommand(fs, hostname),
      })

      return {
        password,
        hostname,
        platform: process.platform,
        target: result.target,
      }
    })

    const password = Effect.fn("ServiceManager.password")(function* () {
      const stored = yield* readStoredConfig(fs)
      if (stored?.password) return stored.password
      if (process.env.OPENCODE_PASSWORD) return process.env.OPENCODE_PASSWORD
      if (process.env.OPENCODE_SERVER_PASSWORD) return process.env.OPENCODE_SERVER_PASSWORD
      return yield* new ServiceError({
        message: "OpenCode service password is not configured. Run `opencode service install` first.",
      })
    })

    return Service.of({ install, password })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provideMerge(platformLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
)
