import { Effect, Layer } from "effect"
import * as ServicePlatform from "./platform"
import { ServiceError } from "./shared"

export const layer = Layer.succeed(
  ServicePlatform.Service,
  ServicePlatform.Service.of({
    install: () => Effect.fail(new ServiceError({ message: `Unsupported platform: ${process.platform}` })),
  }),
)
