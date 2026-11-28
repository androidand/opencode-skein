import { expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstanceEffect, tmpdir } from "../fixture/fixture"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { usable } from "@/session/overflow"

const PROVIDER = "fit-verdict"
const MODEL = "fitme"
// The host in this fixture is configured with n_ctx 81,920 and --n-predict 8,192,
// so llama-skein reports max_safe_ctx 67,174 and rejects prompts above it with 413.
const CONFIGURED = 81_920
const TRIMMED = 67_174
const OUTPUT = 8_192

const providerLayer = () =>
  LayerNode.compile(
    LayerNode.group([
      Provider.node,
      FSUtil.node,
      Env.node,
      Config.node,
      Auth.node,
      Plugin.node,
      ModelsDev.node,
      RuntimeFlags.node,
    ]),
  )

const instanceStoreLayer = LayerNode.compile(InstanceStore.node, [[InstanceStore.bootstrapNode, InstanceBootstrap.node]])

const runList = (directory: string) =>
  Effect.runPromise(
    Provider.use
      .list()
      .pipe(provideInstanceEffect(directory))
      .pipe(Effect.provide(Layer.mergeAll(providerLayer(), instanceStoreLayer, AppNodeBuilder.build(CrossSpawnSpawner.node)))),
  )

const config = (baseURL: string) =>
  JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      [PROVIDER]: {
        name: "Fit Verdict",
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "test", baseURL },
        discoverModels: true,
      },
    },
  })

const write = async (dir: string, baseURL: string) => {
  await Bun.write(path.join(dir, "opencode.json"), config(baseURL))
}

const noReservation = { compaction: undefined } as never

test("a fit-derived verdict does not outlive the context number it described", async () => {
  // fork: `fitDerivedContextModels` is module-level while provider state is per-instance,
  // and `usable()` takes the small fit buffer from the verdict alone. So a model marked
  // fit-derived in one instance can be re-discovered by another instance that has no
  // previously-known context for it: the `previouslyKnownContext` guard is absent, the raw
  // n_ctx is adopted, and the stale verdict keeps the small buffer — compaction then aims
  // at 79,872 against a host that answers 413 above 67,174.
  let available = true
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const pathname = new URL(req.url).pathname
      if (pathname === "/v1/models")
        return Response.json({
          object: "list",
          data: [{ id: MODEL, name: "Fit Me", context_length: CONFIGURED, max_output_tokens: OUTPUT }],
        })
      if (pathname === "/api/fit")
        return available
          ? Response.json({
              models: [
                {
                  model: MODEL,
                  fit_level: "tight",
                  max_safe_ctx: TRIMMED,
                  configured_ctx: CONFIGURED,
                  backend: "llamacpp",
                },
              ],
            })
          : new Response("not found", { status: 404 })
      return new Response("not found", { status: 404 })
    },
  })
  const providerID = ProviderV2.ID.make(PROVIDER)
  try {
    const baseURL = `http://localhost:${server.port}/v1`

    await using first = await tmpdir({ init: async (dir) => await write(dir, baseURL) })
    const fitted = (await runList(first.path))[providerID]
    expect(fitted.models[MODEL].limit.context).toBe(TRIMMED)
    expect(Provider.isFitDerivedContext(providerID, MODEL)).toBe(true)
    expect(usable({ cfg: noReservation, model: fitted.models[MODEL] })).toBe(65_126)

    available = false
    await using second = await tmpdir({ init: async (dir) => await write(dir, baseURL) })
    const stale = (await runList(second.path))[providerID]
    expect(stale.models[MODEL].limit.context).toBe(CONFIGURED)
    expect(Provider.isFitDerivedContext(providerID, MODEL)).toBe(false)
    expect(usable({ cfg: noReservation, model: stale.models[MODEL] })).toBe(73_728)
  } finally {
    Provider.noteFitDerivedContext(providerID, MODEL, false)
    await server.stop()
  }
})
