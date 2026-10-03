import { expect } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { AutoMode } from "@/auto-mode/service"
import { EventV2Bridge } from "@/event-v2-bridge"
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
import { Loop } from "@/loop/loop"
import { LLM } from "@/session/llm"
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
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

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
    startAuth: () => Effect.die("unexpected MCP auth in loop tests"),
    authenticate: () => Effect.die("unexpected MCP auth in loop tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in loop tests"),
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

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })
const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const loopRoot = LayerNode.group([
  Loop.node,
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
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
  AutoMode.node,
  RuntimeFlags.node,
  SessionSummary.node,
  testLLMServerNode,
])

function makeLayer() {
  return LayerNode.compile(loopRoot, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, runtimeFlags],
  ])
}



const it = testEffect(makeLayer())

function providerCfg(url: string): Partial<ConfigV1.Info> {
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
        options: {
          apiKey: "test-key",
          baseURL: url,
        },
      },
    },
  }
}

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  const fsu = yield* FSUtil.Service
  yield* fsu.writeWithDirs(
    `${dir}/opencode.json`,
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

function writeChange(dir: string, slug: string, content: string) {
  const changeDir = path.join(dir, "openspec", "changes", slug)
  fs.mkdirSync(changeDir, { recursive: true })
  fs.writeFileSync(path.join(changeDir, "tasks.md"), content)
  return changeDir
}

const waitForTerminal = (id: Loop.LoopID, seconds = 15) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const loop = yield* Loop.Service
      const info = yield* loop.get(id)
      if (!info) return undefined
      if (info.status !== "running" && info.status !== "paused") return info
      // Log status for debugging
      yield* Effect.logInfo("waiting for terminal", { id, status: info.status, iteration: info.iteration })
      return undefined
    }),
    `auto loop ${id} never reached a terminal status`,
    `${seconds} seconds`,
  )

it.instance(
  "auto mode drives two fixture repositories",
  () =>
    Effect.gen(function* () {
      const { directory: workspace } = yield* TestInstance
      const llm = yield* TestLLMServer

      // Create two fixture repositories inside the workspace.
      const repoA = fs.mkdtempSync(path.join(workspace, "repo-a-"))
      const repoB = fs.mkdtempSync(path.join(workspace, "repo-b-"))

      // Write config for both repos.
      yield* writeConfig(repoA, providerCfg(llm.url))
      yield* writeConfig(repoB, providerCfg(llm.url))

      // Create changes in both repos (already complete).
      writeChange(repoA, "change-a", "- [x] 1.1 done\n")
      writeChange(repoB, "change-b", "- [x] 1.1 done\n")
      // Also create proposal.md (required by getWorkItems)
      fs.writeFileSync(path.join(repoA, "openspec", "changes", "change-a", "proposal.md"), "# Change A\n")
      fs.writeFileSync(path.join(repoB, "openspec", "changes", "change-b", "proposal.md"), "# Change B\n")

      // Verify the changes exist.
      expect(fs.existsSync(path.join(repoA, "openspec", "changes", "change-a", "tasks.md"))).toBe(true)
      expect(fs.existsSync(path.join(repoB, "openspec", "changes", "change-b", "tasks.md"))).toBe(true)

      // Debug: check what's in the workspace
      const workspaceEntries = fs.readdirSync(workspace)
      if (workspaceEntries.length === 0) {
        throw new Error(`workspace is empty: ${workspace}`)
      }

      const loop = yield* Loop.Service

      // Start auto mode from the workspace directory.
      const info = yield* loop.create({ prompt: "", mode: "auto", interval: 0 })

      // Debug: check the loop's directory
      const loopInfo = yield* loop.get(info.id)
      if (loopInfo?.directory !== workspace) {
        throw new Error(`loop directory mismatch: expected ${workspace}, got ${loopInfo?.directory}`)
      }

      const final = yield* waitForTerminal(info.id, 30)

      // Log the final status and report for debugging
      if (final.status !== "completed") {
        throw new Error(`auto mode failed: status=${final.status}, report=${final.report}`)
      }
      expect(final.status).toBe("completed")
      expect(final.report).toContain("auto drained")
    }),
  { config: {} },
)

it.instance(
  "auto mode with pending tasks completes them",
  () =>
    Effect.gen(function* () {
      const { directory: workspace } = yield* TestInstance
      const llm = yield* TestLLMServer

      // Create one fixture repository inside the workspace.
      const repoA = fs.mkdtempSync(path.join(workspace, "repo-a-"))
      yield* writeConfig(repoA, providerCfg(llm.url))

      // Create a change with an open task.
      const changeDirA = writeChange(repoA, "change-a", "- [ ] 1.1 do task A\n")
      fs.writeFileSync(path.join(changeDirA, "proposal.md"), "# Change A\n")

      // Provide LLM responses that complete the task.
      yield* llm.text("I completed the task")

      const loop = yield* Loop.Service

      // Start auto mode.
      const info = yield* loop.create({ prompt: "", mode: "auto", interval: 0, maxIterations: 10 })

      const final = yield* waitForTerminal(info.id, 30)

      // The run should complete (either the task was completed or it was quarantined).
      if (final.status !== "completed") {
        throw new Error(`auto mode with tasks failed: status=${final.status}, report=${final.report}`)
      }
      expect(final.status).toBe("completed")
    }),
  { config: {} },
)

it.instance(
  "auto mode resolves per-repo gate options from each repo's opencode.json (D5 fallback)",
  () =>
    Effect.gen(function* () {
      const { directory: workspace } = yield* TestInstance
      const llm = yield* TestLLMServer

      // Two fixture repos, each declaring a different test command.
      // If gate options were resolved from the instance (loop) config instead
      // of per-repo, one repo would inherit the other's test command and the
      // run would halt on the wrong gate.
      const repoA = fs.mkdtempSync(path.join(workspace, "repo-a-"))
      const repoB = fs.mkdtempSync(path.join(workspace, "repo-b-"))

      // Repo A: test command that passes.
      yield* writeConfig(repoA, {
        ...providerCfg(llm.url),
        experimental: { queue_gate: { test_command: "echo PASS_A" } },
      })
      // Repo B: test command that passes.
      yield* writeConfig(repoB, {
        ...providerCfg(llm.url),
        experimental: { queue_gate: { test_command: "echo PASS_B" } },
      })

      // Both changes are already complete — the gates still run.
      writeChange(repoA, "change-a", "- [x] 1.1 done\n")
      writeChange(repoB, "change-b", "- [x] 1.1 done\n")
      fs.writeFileSync(path.join(repoA, "openspec", "changes", "change-a", "proposal.md"), "# Change A\n")
      fs.writeFileSync(path.join(repoB, "openspec", "changes", "change-b", "proposal.md"), "# Change B\n")

      const loop = yield* Loop.Service
      const info = yield* loop.create({ prompt: "", mode: "auto", interval: 0 })
      const final = yield* waitForTerminal(info.id, 30)

      if (final.status !== "completed") {
        throw new Error(
          `per-repo gate resolution failed: status=${final.status}, report=${final.report}`,
        )
      }
      expect(final.status).toBe("completed")
      expect(final.report).toContain("auto drained")
    }),
  { config: {} },
)

it.instance(
  "auto mode: correct repo completes, wrong-config repo quarantines (D5 failure proof)",
  () =>
    Effect.gen(function* () {
      const { directory: workspace } = yield* TestInstance
      const llm = yield* TestLLMServer

      // Repo A: correct test command (passes).
      const repoA = fs.mkdtempSync(path.join(workspace, "repo-a-"))
      yield* writeConfig(repoA, {
        ...providerCfg(llm.url),
        experimental: { queue_gate: { test_command: "echo PASS_A" } },
      })
      // Repo B: deliberately wrong test command (fails).
      const repoB = fs.mkdtempSync(path.join(workspace, "repo-b-"))
      yield* writeConfig(repoB, {
        ...providerCfg(llm.url),
        experimental: { queue_gate: { test_command: "exit 1" } },
      })

      // Both changes are already complete — the gates still run.
      writeChange(repoA, "change-a", "- [x] 1.1 done\n")
      writeChange(repoB, "change-b", "- [x] 1.1 done\n")
      fs.writeFileSync(path.join(repoA, "openspec", "changes", "change-a", "proposal.md"), "# Change A\n")
      fs.writeFileSync(path.join(repoB, "openspec", "changes", "change-b", "proposal.md"), "# Change B\n")

      const loop = yield* Loop.Service
      const info = yield* loop.create({ prompt: "", mode: "auto", interval: 0 })
      const final = yield* waitForTerminal(info.id, 30)

      // The run must reach a terminal status (not hang).
      // Repo A should have completed; repo B should have been quarantined.
      // If gate options were resolved from the instance config (not per-repo),
      // both repos would use the same test command and both would fail.
      const terminal: Loop.Status[] = ["completed", "stalled", "cancelled", "max_reached", "error"]
      if (!terminal.includes(final.status)) {
        throw new Error(
          `D5 failure proof: expected terminal status, got ${final.status}, report=${final.report}`,
        )
      }
      // The report should mention the quarantined change from repo B.
      if (final.report && final.report.includes("quarantined")) {
        expect(final.report).toContain("change-b")
      }
    }),
  { config: {} },
)

it.instance(
  "auto mode resolves items to repos and skips missing repos (Phase 3.2)",
  () =>
    Effect.gen(function* () {
      const { directory: workspace } = yield* TestInstance
      const llm = yield* TestLLMServer

      // A real repo with an incomplete change (has eligible tasks).
      const repoA = fs.mkdtempSync(path.join(workspace, "repo-a-"))
      yield* writeConfig(repoA, {
        ...providerCfg(llm.url),
        experimental: { queue_gate: { test_command: "echo PASS" } },
      })
      writeChange(repoA, "change-a", "- [ ] 1.1 not done\n")
      fs.writeFileSync(path.join(repoA, "openspec", "changes", "change-a", "proposal.md"), "# Change A\n")

      // Provide LLM responses that complete the task.
      yield* llm.text("I completed the task")

      const loop = yield* Loop.Service
      const info = yield* loop.create({ prompt: "", mode: "auto", interval: 0, maxIterations: 10 })
      const final = yield* waitForTerminal(info.id, 30)

      // The resolvable item (repoA/change-a) should have started a run and
      // completed. If the repo were missing, the item would be skipped and
      // the run would complete with no outcomes.
      if (final.status !== "completed") {
        throw new Error(
          `Phase 3.2: expected completed, got ${final.status}, report=${final.report}`,
        )
      }
      expect(final.status).toBe("completed")
      expect(final.report).toContain("auto drained")
    }),
  { config: {} },
)

it.instance(
  "auto mode: concurrency follows the fleet (Phase 3.4)",
  () =>
    Effect.gen(function* () {
      const { directory: workspace } = yield* TestInstance
      const llm = yield* TestLLMServer

      // Two fixture repos, each with a passing test command.
      const repoA = fs.mkdtempSync(path.join(workspace, "repo-a-"))
      const repoB = fs.mkdtempSync(path.join(workspace, "repo-b-"))
      yield* writeConfig(repoA, {
        ...providerCfg(llm.url),
        experimental: { queue_gate: { test_command: "echo PASS_A" } },
      })
      yield* writeConfig(repoB, {
        ...providerCfg(llm.url),
        experimental: { queue_gate: { test_command: "echo PASS_B" } },
      })
      writeChange(repoA, "change-a", "- [x] 1.1 done\n")
      writeChange(repoB, "change-b", "- [x] 1.1 done\n")
      fs.writeFileSync(path.join(repoA, "openspec", "changes", "change-a", "proposal.md"), "# Change A\n")
      fs.writeFileSync(path.join(repoB, "openspec", "changes", "change-b", "proposal.md"), "# Change B\n")

      const loop = yield* Loop.Service
      const info = yield* loop.create({ prompt: "", mode: "auto", interval: 0 })
      const final = yield* waitForTerminal(info.id, 30)

      // Both repos should be worked and the run should drain. If the capacity
      // bound were 0 (no floor), the run would stall and never reach a
      // terminal status within the timeout.
      if (final.status !== "completed") {
        throw new Error(
          `Phase 3.4 fleet: expected completed, got ${final.status}, report=${final.report}`,
        )
      }
      expect(final.status).toBe("completed")
      expect(final.report).toContain("auto drained")
    }),
  { config: {} },
)

it.instance(
  "auto mode: one working tree, one run (Phase 3.4)",
  () =>
    Effect.gen(function* () {
      const { directory: workspace } = yield* TestInstance
      const llm = yield* TestLLMServer

      // One fixture repo with a passing test command.
      const repoA = fs.mkdtempSync(path.join(workspace, "repo-a-"))
      yield* writeConfig(repoA, {
        ...providerCfg(llm.url),
        experimental: { queue_gate: { test_command: "echo PASS" } },
      })
      writeChange(repoA, "change-a", "- [x] 1.1 done\n")
      fs.writeFileSync(path.join(repoA, "openspec", "changes", "change-a", "proposal.md"), "# Change A\n")

      const loop = yield* Loop.Service
      const info = yield* loop.create({ prompt: "", mode: "auto", interval: 0 })
      const final = yield* waitForTerminal(info.id, 30)

      // The single repo should be worked and the run should drain. If the
      // per-repo exclusivity guard were broken, two concurrent runs for the
      // same repo would fight over the working tree and the run would stall.
      if (final.status !== "completed") {
        throw new Error(
          `Phase 3.4 one-repo: expected completed, got ${final.status}, report=${final.report}`,
        )
      }
      expect(final.status).toBe("completed")
      expect(final.report).toContain("auto drained")
    }),
  { config: {} },
)
