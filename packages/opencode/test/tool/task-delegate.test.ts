// Phase 2, task 2.5 live: a parent whose local host has no free slot delegates
// the task to an idle peer, and the peer's reply comes back as the task result.
//
// Drives the REAL TaskTool end to end: a busy-hardware server makes the parent's
// host read as `no-slot`, an owned idle opencode session on a cloud provider is
// the peer, and the peer's `prompt` stub reads the task id out of the envelope
// and settles the reply exactly as a real peer's `send_peer_message` would on its
// inbound path — so the parent's `delegated.reply` resolves and the tool returns
// it as the task output.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Permission } from "@/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { settleTaskReply } from "../../src/peer/delegate"
import { Provider } from "../../src/provider/provider"

let tmp: string
let server: Server | undefined
let baseURL = ""

const localProviderID = ProviderV2.ID.make("local-full")
const cloudProviderID = ProviderV2.ID.make("anthropic")
const localModelID = ModelV2.ID.make("local-model")
const cloudModelID = ModelV2.ID.make("cloud-model")

const localModel = { providerID: localProviderID, modelID: localModelID } as const
const cloudModel = { providerID: cloudProviderID, modelID: cloudModelID } as const

afterEach(async () => {
  await disposeAllInstances()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(tmp, { recursive: true, force: true })
  server?.close()
})

let previousConfigDir: string | undefined

beforeEach(async () => {
  // A real local endpoint that reports its only slot is taken, so the parent's
  // host reads as `no-slot` and the task must delegate rather than place.
  server = createServer((req, res) => {
    if (req.url === "/api/hardware") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          gpus: [{ utilization_pct: 99 }],
          inference: { busy: true, in_flight: 1, slots_total: 1 },
          loaded_model: { id: "local-model" },
        }),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
  const port = (server!.address() as { port: number }).port
  baseURL = `http://127.0.0.1:${port}/v1`
  tmp = await mkdtemp(join(tmpdir(), "task-delegate-"))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  // Isolate the foreign-sidecar registry so real fleet sessions are invisible.
  process.env.CLAUDE_CONFIG_DIR = tmp
})

const providerLayer = Layer.mock(Provider.Service, {
  list: () =>
    Effect.succeed({
      [localProviderID]: {
        id: localProviderID,
        name: "local-full",
        npm: "@ai-sdk/openai-compatible",
        api: baseURL,
        source: "config",
        env: [],
        options: { baseURL },
        models: {
          [localModelID]: {
            id: localModelID,
            providerID: localProviderID,
            name: "local-model",
            api: { id: localModelID, url: "", npm: "@ai-sdk/openai-compatible" },
            status: "active",
            headers: {},
            options: {},
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 100000, input: undefined, output: 0 },
            capabilities: {
              temperature: true,
              reasoning: false,
              attachment: false,
              toolcall: true,
              input: { text: true, audio: false, image: false, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
              interleaved: false,
            },
            family: "",
            release_date: "",
            variants: {},
          },
        },
      },
    }),
  setModelContextLimit: () => Effect.succeed(true),
})

const permissionLayer = Layer.mock(Permission.Service, { list: () => Effect.succeed([]) })

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Permission.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer(flags)],
      [Permission.node, permissionLayer],
    ],
  )

const it = testEffect(layer())

const seed = Effect.fn("TaskToolDelegateTest.seed")(function* (
  title: string,
  model: typeof localModel,
  updatedAt = Date.now(),
) {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: tmp, root: tmp },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    variant: "xhigh",
    time: { created: updatedAt },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

// A peer session the parent owns but is not the caller of. Its `updatedAt` is
// old so resolveMessageTargets reads it as idle rather than busy-in-window.
const seedPeer = Effect.fn("TaskToolDelegateTest.seedPeer")(function* (title: string, model: typeof cloudModel) {
  const session = yield* Session.Service
  const peer = yield* session.create({ title })
  const when = Date.now() - 120_000
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: peer.id,
    agent: "build",
    model,
    time: { created: when },
  })
  yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: peer.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: tmp, root: tmp },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: when },
  })
  return peer
})

const REPLY_TEXT = "peer answer: the cache key path is resolved lazily"

function makeOps(): TaskPromptOps {
  // The peer's `prompt` simulates receiving the delegated envelope: it reads the
  // `[peer-task <id>]` header, settles the reply with a matching marker, and
  // returns a normal task part — exactly what a real peer's reply does on its
  // inbound path, so the parent's `delegated.reply` resolves to it.
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        const text = input.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { text: string }).text)
          .join("\n")
        const m = text.match(/\[peer-task\s+([A-Za-z0-9_-]+)\]/)
        if (m) settleTaskReply(`[peer-task-result ${m[1]}]\n${REPLY_TEXT}`)
        const id = MessageID.ascending()
        return {
          info: {
            id,
            role: "assistant" as const,
            parentID: input.messageID ?? MessageID.ascending(),
            sessionID: input.sessionID,
            mode: input.agent ?? "general",
            agent: input.agent ?? "general",
            cost: 0,
            path: { cwd: tmp, root: tmp },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: input.model?.modelID ?? cloudModelID,
            providerID: input.model?.providerID ?? cloudProviderID,
            time: { created: Date.now() },
            finish: "stop",
          },
          parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text" as const, text: REPLY_TEXT }],
        } as unknown as SessionV1.WithParts
      }),
  }
}

const runTask = (
  chat: { id: SessionID },
  assistant: SessionV1.Assistant,
  promptOps: TaskPromptOps,
) =>
  Effect.gen(function* () {
    const tool = yield* TaskTool
    const def = yield* tool.init()
    return yield* def.execute(
      { description: "delegate smoke", prompt: "report the answer", subagent_type: "general" },
      {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      },
    )
  })

describe("tool.task peer delegation (2.5)", () => {
  it.instance(
    "full host delegates an opencode cloud peer; the peer's reply becomes the task result",
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed("parent", localModel)
      yield* seedPeer("cloud peer", cloudModel)

      const result = yield* runTask(chat, assistant, makeOps()).pipe(
        Effect.catchCause(() => Effect.succeed({ __defect: true as const })),
      )

      if ("__defect" in result) throw new Error("delegation did not complete")
      const text = ((result as { output: string }).output ?? "")
      expect(text).toContain(REPLY_TEXT)
    }),
    20_000,
  )
})
