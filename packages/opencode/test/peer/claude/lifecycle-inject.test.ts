// Regression for lifecycle.ts deliver: an inbound A2A message to a real,
// idle session must actually land as a prompt turn, not die.
//
// The bug: `deliver` called `session.get(id)` to discover the target
// session's directory *before* an InstanceRef was ever established — but
// `Session.Service.get` itself requires one (session.ts:549,
// `InstanceState.context`). It died with "InstanceRef not provided" on the
// very first Session-service call, 100% of the time, regardless of the
// target's idle/busy status. Confirmed live in production logs: 48
// occurrences in one day, including against a session idle for 4+ hours.
//
// The fix: the sidecar manager already knows the owning session's directory
// from when `ensureSidecar` was called for it (`sidecarDirectoryFor`) — no
// session lookup needed to find it. `deliver` now resolves the directory
// from there first, establishes InstanceRef via `instanceStore.provide`,
// and only then touches any session-scoped service.
//
// Harness note: this test explicitly threads ONE `InstanceStore.Service`
// instance through both the test's own session creation AND (implicitly,
// via the sidecar's real deliver callback) lifecycle.ts's internal
// `instanceStore.load`/`.provide` calls, by calling `instanceStore.provide`
// itself rather than using the `it.instance`/`withTmpdirInstance` test
// helper. That helper provides its own separate `testInstanceStoreLayer`
// *around* the test body, independent of whatever `InstanceStore.node`
// `ClaudeSidecarLifecycle.node` pulls into this file's own layer graph —
// two different InstanceStore instances would mean the sidecar's delivery
// path boots a second, empty instance for the same directory and never
// finds the session created via the first. Using one explicit
// `InstanceStore.Service` for both sides is what makes this test actually
// exercise the real bug instead of masking it.
import { expect } from "bun:test"
import { MessageV2 } from "../../../src/session/message-v2"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Agent as AgentSvc } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "@/env"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionSummary } from "@/session/summary"
import { Instruction } from "@/session/instruction"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Skill } from "@/skill"
import { SystemPrompt } from "@/session/system"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "@/format"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { ClaudeSidecarLifecycle } from "@/peer/claude/lifecycle"
import { keyFileHash } from "@/peer/claude/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { pollWithTimeout, testEffect } from "../../lib/effect"
import { TestLLMServer } from "../../lib/llm-server"
import { tmpdirScoped } from "../../fixture/fixture"
import { connect } from "net"
import { readFile, readdir, mkdir, mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    instructions: () => Effect.succeed([]),
    resourceTemplates: () => Effect.succeed({}),
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in lifecycle-inject test"),
    authenticate: () => Effect.die("unexpected MCP auth in lifecycle-inject test"),
    finishAuth: () => Effect.die("unexpected MCP auth in lifecycle-inject test"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })
const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

// One InstanceStore.Service for the whole graph — see the file header. Both
// this test's own `session.create` and lifecycle.ts's internal
// `instanceStore.load`/`.provide` inside `deliver` resolve through it.
const root = LayerNode.group([
  ClaudeSidecarLifecycle.node,
  InstanceStore.node,
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  SessionSummary.node,
  Env.node,
])

const env = LayerNode.compile(LayerNode.group([root, testLLMServerNode]), [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  [RuntimeFlags.node, runtimeFlags],
  [InstanceStore.bootstrapNode, noopBootstrap],
])

const it = testEffect(env)

function providerCfg(url: string) {
  return {
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

function waitForLine(stream: NodeJS.ReadableStream, predicate: (event: any) => boolean, timeoutMs = 10_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ""
    const timer = setTimeout(() => reject(new Error("timed out waiting for sidecar registration")), timeoutMs)
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      let idx: number
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (predicate(event)) {
            clearTimeout(timer)
            resolve(event)
            return
          }
        } catch {
          // ignore
        }
      }
    })
  })
}

it.live(
  "an inbound peer message to an idle session is actually injected as a prompt turn",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const instanceStore = yield* InstanceStore.Service
      const dir = yield* tmpdirScoped({ git: true, config: providerCfg(llm.url) })

      // Point the real Claude session registry at a scratch dir for this
      // test, same as sidecar-e2e.test.ts / pty-repro.test.ts.
      const claudeConfigDir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "lifecycle-inject-claude-")))
      yield* Effect.promise(() => mkdir(join(claudeConfigDir, "sessions"), { recursive: true }))
      const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = claudeConfigDir

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
          else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
        }),
      )

      yield* llm.text("hello from the injected turn")

      yield* instanceStore.provide(
        { directory: dir },
        Effect.gen(function* () {
          // Force ClaudeSidecarLifecycle's layer to actually build — a Layer
          // no one requests never runs its construction effect, and its
          // event-listener wiring (the thing under test) never happens.
          yield* ClaudeSidecarLifecycle.Service
          const session = yield* Session.Service

          const info = yield* session.create({ title: "lifecycle-inject target" })

          // ensureFor(Session.Event.Created) spawns the real sidecar
          // asynchronously; wait for its registration file, exactly like the
          // e2e tests do.
          let pid: number | undefined
          for (let i = 0; i < 100 && !pid; i++) {
            const entries = yield* Effect.promise(() => readdir(join(claudeConfigDir, "sessions")).catch(() => [] as string[]))
            const jsonFile = entries.find((e) => e.endsWith(".json"))
            if (jsonFile) pid = Number(jsonFile.replace(".json", ""))
            else yield* Effect.sleep("50 millis")
          }
          if (!pid) return yield* Effect.fail(new Error("sidecar never registered"))

          const registryPath = join(claudeConfigDir, "sessions", `${pid}.json`)
          const registration = JSON.parse(yield* Effect.promise(() => readFile(registryPath, "utf8")))
          const socketPath: string = registration.messagingSocketPath
          const hash = keyFileHash(socketPath)
          const keyFile = JSON.parse(
            yield* Effect.promise(() => readFile(join(claudeConfigDir, "sessions", `${pid}.${hash}.key`), "utf8")),
          )

          // Send a real inbound frame over the real socket — the exact path
          // a genuine Claude Code peer uses.
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                const socket = connect(socketPath)
                socket.once("connect", () => {
                  const frames = [
                    { type: "auth", token: keyFile.peerToken },
                    {
                      msgV: 1,
                      msg_id: "lifecycle-inject-1",
                      type: "user",
                      message: {
                        role: "user",
                        content:
                          '<cross-session-message from="uds:/tmp/x.sock" from-name="peer" from-mode="idle">\nhello from a peer\n</cross-session-message>',
                      },
                      priority: "next",
                      from: "uds:/tmp/x.sock",
                    },
                  ]
                  socket.write(frames.map((f) => JSON.stringify(f)).join("\n") + "\n", () => socket.end())
                })
                socket.once("close", () => resolve())
                socket.once("error", reject)
              }),
          )

          // The bug: deliver dies on `session.get` before InstanceRef exists,
          // so no prompt turn ever runs and no assistant message appears.
          // The fix: it does, and the mocked LLM's reply lands as a message.
          const parts = yield* pollWithTimeout(
            Effect.gen(function* () {
              const messages = yield* session.messages({ sessionID: info.id })
              const assistantText = messages
                .flatMap((m) => m.parts)
                .find((p) => p.type === "text" && p.text === "hello from the injected turn")
              return assistantText ? messages : undefined
            }),
            "injected peer message never produced an assistant reply — delivery failed",
            "10 seconds",
          )
          expect(parts.length).toBeGreaterThan(0)
        }),
      )
    }),
  20_000,
)
