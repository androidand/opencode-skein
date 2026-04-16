import { Provider } from "@/provider"
import { Effect, Layer, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { mapValues } from "remeda"

const ConfigProvidersResponse = Schema.Struct({
  providers: Schema.Array(Provider.Info),
  default: Schema.Record(Schema.String, Schema.String),
})

const root = "/config"

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          success: ConfigProvidersResponse,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Config routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )

export const configHandlers = Layer.unwrap(
  Effect.gen(function* () {
    const svc = yield* Provider.Service

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const all = mapValues(yield* svc.list().pipe(Effect.orDie), (item) => item)
      return {
        providers: Object.values(all),
        default: mapValues(all, (item) => Provider.sort(Object.values(item.models))[0].id),
      }
    })

    return HttpApiBuilder.group(ConfigApi, "config", (handlers) => handlers.handle("providers", providers))
  }),
).pipe(Layer.provide(Provider.defaultLayer))
