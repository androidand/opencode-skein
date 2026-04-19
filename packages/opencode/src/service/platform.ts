import { Context, Effect } from "effect"
import type { PlatformInstallInput, PlatformInstallResult } from "./shared"
import { ServiceError } from "./shared"

export interface Interface {
  readonly install: (input: PlatformInstallInput) => Effect.Effect<PlatformInstallResult, ServiceError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ServicePlatform") {}
