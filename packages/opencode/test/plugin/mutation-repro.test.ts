/**
 * Reproducer tests for plugin-hook mutation bugs analogous to #26546
 * (gemini-auth-plugin / `toPublicInfo`, fixed by #26550).
 *
 * Status:
 *   - Finding 4 (plugin.config): FIXED in this PR by projecting cfg
 *     through `toJsonSafe` at the HTTP boundary in
 *     `ConfigHttpApi.get`. The active reproducer below asserts the
 *     HTTP `/config` response, not Config.Service.get(); internal cfg
 *     is allowed to carry whatever plugins put there, the public API
 *     is the contract that matters.
 *   - Findings 1-3 (tool.definition, messages.transform, system.transform):
 *     reproducers SKIPPED. The `output`-mutation contract is documented
 *     public API (see packages/web/src/content/docs/plugins.mdx); blanket
 *     clone-and-return breaks plugins that mutate by reference, and
 *     blanket in-place scrub corrupts shared Effect Schema instances
 *     in `tool.parameters`. Per-hook design needed.
 */
import { afterAll, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import path from "path"
import { pathToFileURL } from "url"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const disableDefault = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"

const { Plugin } = await import("../../src/plugin/index")
const { Config } = await import("../../src/config/config")
const { Server } = await import("../../src/server/server")

const it = testEffect(Layer.mergeAll(Plugin.defaultLayer, Config.defaultLayer, CrossSpawnSpawner.defaultLayer))

afterAll(() => {
  if (disableDefault === undefined) {
    delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
    return
  }
  process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = disableDefault
})

function withProject<A, E, R>(
  source: string,
  self: Effect.Effect<A, E, R> | ((dir: string) => Effect.Effect<A, E, R>),
) {
  return provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      const file = path.join(dir, "plugin.ts")
      yield* Effect.all(
        [
          Effect.promise(() => Bun.write(file, source)),
          Effect.promise(() =>
            Bun.write(
              path.join(dir, "opencode.json"),
              JSON.stringify(
                {
                  $schema: "https://opencode.ai/config.json",
                  plugin: [pathToFileURL(file).href],
                },
                null,
                2,
              ),
            ),
          ),
        ],
        { discard: true, concurrency: 2 },
      )
      return yield* typeof self === "function" ? self(dir) : self
    }),
  )
}

/** True if `value` contains only values that can cross JSON boundaries without loss. */
function isJsonSafe(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || value === undefined) {
    return false
  }
  if (value === null || typeof value !== "object") return true
  if (seen.has(value as object)) return true
  seen.add(value as object)
  if (Array.isArray(value)) return value.every((v) => isJsonSafe(v, seen))
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!isJsonSafe((value as Record<string, unknown>)[key], seen)) return false
  }
  return true
}

describe("plugin hook mutation reproducers (analog of #26546)", () => {
  // -------------------------------------------------------------------------
  // Finding 1: tool.definition — packages/opencode/src/tool/registry.ts:325
  // Plugin can attach function values to `output.parameters`; downstream LLM
  // tool-use serialization drops them, producing malformed tool schemas.
  // -------------------------------------------------------------------------
  it.live.skip("tool.definition: output stays JSON-safe after plugin mutation", () =>
    withProject(
      [
        "export default async () => ({",
        '  "tool.definition": (_input, output) => {',
        "    // Simulate a misbehaving plugin attaching a function value",
        "    // (e.g. trying to inject a custom validator, runtime hook, etc.)",
        "    output.parameters = {",
        "      ...((output.parameters as any) ?? {}),",
        "      __pluginFn: () => 'side effect',",
        "    }",
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const output: { description: string; parameters: any } = {
          description: "test tool",
          parameters: { type: "object", properties: {} },
        }
        yield* plugin.trigger("tool.definition", { toolID: "test_tool" }, output)
        // Future contract: function-valued mutations must not leak back
        // to the tool definition pipeline without breaking output
        // mutation semantics.
        expect(isJsonSafe(output)).toBe(true)
      }),
    ),
  )

  // -------------------------------------------------------------------------
  // Finding 2: experimental.chat.messages.transform
  // Call sites: session/prompt.ts:1566 and session/compaction.ts:407.
  // The hook contract is the same; one test covers both.
  // -------------------------------------------------------------------------
  it.live.skip("experimental.chat.messages.transform: output stays JSON-safe after plugin mutation", () =>
    withProject(
      [
        "export default async () => ({",
        '  "experimental.chat.messages.transform": (_input, output) => {',
        "    output.messages = [",
        "      ...output.messages,",
        "      // Plugin attaches a function in a message-shaped object;",
        "      // downstream MessageV2.toModelMessagesEffect / persistence",
        "      // will drop the field, corrupting message ordering or",
        "      // failing schema validation.",
        "      { id: 'plug', role: 'assistant', toolCall: () => 'oops' } as any,",
        "    ]",
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const output = { messages: [] as any[] }
        yield* plugin.trigger("experimental.chat.messages.transform", {}, output)
        // Future contract: messages handed back to the prompt /
        // compaction pipeline must be JSON-safe. The same hook fires from
        // both session/prompt.ts:1566 and session/compaction.ts:407.
        expect(isJsonSafe(output)).toBe(true)
      }),
    ),
  )

  // -------------------------------------------------------------------------
  // Finding 3: experimental.chat.system.transform — agent/agent.ts:452
  // Plugin can attach function-valued entries to the system prompt array.
  // -------------------------------------------------------------------------
  it.live.skip("experimental.chat.system.transform: output stays JSON-safe after plugin mutation", () =>
    withProject(
      [
        "export default async () => ({",
        '  "experimental.chat.system.transform": (_input, output) => {',
        "    // Plugin pushes a non-string value onto system. After JSON",
        "    // round-trip (e.g. provider request body), the function is",
        "    // dropped, leaving an empty / malformed prompt entry.",
        "    ;(output.system as any[]).push(() => 'dynamic prompt')",
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const output: { system: unknown[] } = { system: ["initial"] }
        yield* plugin.trigger(
          "experimental.chat.system.transform",
          {
            model: {
              providerID: ProviderID.anthropic,
              modelID: ModelID.make("claude-sonnet-4-6"),
            },
          },
          output,
        )
        // Future contract: the system prompt array opencode keeps
        // forwarding to the LLM provider must contain only JSON-safe
        // primitives.
        expect(isJsonSafe(output)).toBe(true)
      }),
    ),
  )

  // -------------------------------------------------------------------------
  // Finding 4: plugin.config() — plugin/index.ts:235
  // The plugin's `config` hook receives the LIVE Config.Info object and can
  // mutate it. Internal cfg may keep runtime values; HTTP `/config` must
  // project those values out before response encoding.
  // -------------------------------------------------------------------------
  it.live("plugin.config(): GET /config response stays JSON-safe after plugin mutation", () =>
    withProject(
      [
        "export default async () => ({",
        "  config: (cfg) => {",
        "    // Misbehaving plugin attaches runtime-only values under a",
        "    // schema-allowed field. Internal state is allowed to carry",
        "    // them, but the HTTP API must project them to JSON-safe data.",
        "    ;(cfg as any).provider = {",
        "      ...((cfg as any).provider ?? {}),",
        "      plugin_runtime: {",
        "        options: {",
        "          fetch: async (input, init) => fetch(input, init),",
        "          pluginBigInt: BigInt(1),",
        "        },",
        "      },",
        "    }",
        "  },",
        "})",
        "",
      ].join("\n"),
      (dir) =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.init()
          const config = yield* Config.Service
          const cfg = yield* config.get()
          expect(typeof cfg.provider?.plugin_runtime?.options?.fetch).toBe("function")
          const headers = { "x-opencode-directory": dir }
          const response = yield* Effect.promise(() =>
            Promise.resolve(Server.Default().app.request("/config", { headers })),
          )
          expect(response.status).toBe(200)
          const body = (yield* Effect.promise(() => response.json())) as Record<string, unknown>
          // Post-fix contract: HTTP /config is the boundary. Whatever the
          // live in-memory cfg looks like, the wire response must be
          // JSON-safe and match the typed schema.
          expect(isJsonSafe(body)).toBe(true)
          const provider = body.provider as Record<string, { options?: Record<string, unknown> }> | undefined
          expect(provider?.plugin_runtime?.options?.fetch).toBeUndefined()
          expect(provider?.plugin_runtime?.options?.pluginBigInt).toBe("1")
        }),
    ),
  )
})
