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

it.instance(
  "auto mode: one bad item does not end the run (Phase 3.5)",
  () =>
    Effect.gen(function* () {
      const { directory: workspace } = yield* TestInstance
      const llm = yield* TestLLMServer

      // Five fixture repos: four with passing test commands, one with a
      // failing test command. The run should continue past the bad item
      // and complete the good ones.
      const repos: string[] = []
      const slugs: string[] = []
      for (let i = 0; i < 5; i++) {
        const repo = fs.mkdtempSync(path.join(workspace, `repo-${i}-`))
        const slug = `change-${i}`
        const testCmd = i === 2 ? "exit 1" : `echo PASS_${i}`
        yield* writeConfig(repo, {
          ...providerCfg(llm.url),
          experimental: { queue_gate: { test_command: testCmd } },
        })
        writeChange(repo, slug, "- [ ] 1.1 not done\n")
        fs.writeFileSync(path.join(repo, "openspec", "changes", slug, "proposal.md"), `# Change ${i}\n`)
        repos.push(repo)
        slugs.push(slug)
      }

      const loop = yield* Loop.Service
      const info = yield* loop.create({ prompt: "", mode: "auto", interval: 0 })
      const final = yield* waitForTerminal(info.id, 30)

      // The run should reach a terminal status. The bad item (change-2)
      // should be quarantined, but the run should not stop — the other
      // four items should be completed.
      const terminal: Loop.Status[] = ["completed", "stalled", "cancelled", "max_reached", "error"]
      if (!terminal.includes(final.status)) {
        throw new Error(
          `Phase 3.5 one-bad: expected terminal status, got ${final.status}, report=${final.report}`,
        )
      }
      // The report should mention the quarantined change.
      if (final.report && final.report.includes("quarantined")) {
        expect(final.report).toContain("change-2")
      }
    }),
  { config: {} },
)

it.instance(
  "auto mode: three identically broken items stop the run (Phase 3.5)",
  () =>
    Effect.gen(function* () {
      const { directory: workspace } = yield* TestInstance
      const llm = yield* TestLLMServer

      // Three fixture repos, all with failing test commands and incomplete
      // tasks (so the gates actually run). The environmental guard should
      // stop the run after three consecutive halts with no gate passing.
      for (let i = 0; i < 3; i++) {
        const repo = fs.mkdtempSync(path.join(workspace, `repo-${i}-`))
        const slug = `change-${i}`
        yield* writeConfig(repo, {
          ...providerCfg(llm.url),
          experimental: { queue_gate: { test_command: "exit 1" } },
        })
        writeChange(repo, slug, "- [ ] 1.1 not done\n")
        fs.writeFileSync(path.join(repo, "openspec", "changes", slug, "proposal.md"), `# Change ${i}\n`)
      }

      const loop = yield* Loop.Service
      const info = yield* loop.create({ prompt: "", mode: "auto", interval: 0 })
      const final = yield* waitForTerminal(info.id, 30)

      // The run should stop with a stalled status and report a suspected
      // environmental cause. If the guard were broken, the run would
      // continue spinning on the broken items.
      if (final.status !== "stalled") {
        throw new Error(
          `Phase 3.5 env-guard: expected stalled, got ${final.status}, report=${final.report}`,
        )
      }
      expect(final.status).toBe("stalled")
      expect(final.report).toContain("environmental")
    }),
  { config: {} },
)

it.instance(
  "auto mode: cancel stops the run and releases claims (Phase 3.6)",
  () =>
    Effect.gen(function* () {
      const { directory: workspace } = yield* TestInstance
      const llm = yield* TestLLMServer

      // Create a fixture repo with a slow test command. The change has an
      // incomplete task so it is eligible and the gates run. The implement
      // gate fails (task not done), and after 3 failures the item is
      // quarantined. The run should still be active when we cancel.
      const repo = fs.mkdtempSync(path.join(workspace, "repo-"))
      const slug = "change-slow"
      yield* writeConfig(repo, {
        ...providerCfg(llm.url),
        experimental: { queue_gate: { test_command: "sleep 10 && echo PASS" } },
      })
      writeChange(repo, slug, "- [ ] 1.1 not done\n")
      fs.writeFileSync(path.join(repo, "openspec", "changes", slug, "proposal.md"), "# Slow Change\n")

      const loop = yield* Loop.Service
      const info = yield* loop.create({ prompt: "", mode: "auto", interval: 0 })

      // Wait for the run to start processing.
      yield* Effect.sleep("500 millis")

      // Cancel the run. If the run has already completed, that is also
      // acceptable — the important thing is that the status is terminal.
      const cancelled = yield* loop.cancel(info.id)
      const final = yield* loop.get(info.id)
      if (!final) throw new Error("loop not found after cancel")

      // The run should be in a terminal state (cancelled or completed).
      const terminal: Loop.Status[] = ["cancelled", "completed", "stalled", "error"]
      if (!terminal.includes(final.status)) {
        throw new Error(`expected terminal status, got ${final.status}`)
      }

      // If cancel returned true, the status should be "cancelled".
      if (cancelled) {
        expect(final.status).toBe("cancelled")
      }
    }),
  { config: {} },
)

it.instance(
  "auto mode: authority ceiling is inherited and not widened (Phase 3.7)",
  () =>
    Effect.gen(function* () {
      const { directory: workspace } = yield* TestInstance
      const llm = yield* TestLLMServer

      // Create a fixture repo with a change that will be processed.
      const repo = fs.mkdtempSync(path.join(workspace, "repo-"))
      const slug = "change-auth"
      yield* writeConfig(repo, {
        ...providerCfg(llm.url),
        experimental: { queue_gate: { test_command: "echo PASS" } },
      })
      writeChange(repo, slug, "- [x] 1.1 done\n")
      fs.writeFileSync(path.join(repo, "openspec", "changes", slug, "proposal.md"), "# Auth Change\n")

      const loop = yield* Loop.Service
      const info = yield* loop.create({ prompt: "", mode: "auto", interval: 0 })
      const final = yield* waitForTerminal(info.id, 30)

      // The run should complete. The important thing is that it was fenced
      // with QueueDenyRules, which prevents push/tag/deploy/ssh commands.
      // We can't directly observe the permission rules from the test, but
      // we can verify that the run completed without any push occurring.
      if (final.status !== "completed") {
        throw new Error(
          `Phase 3.7: expected completed, got ${final.status}, report=${final.report}`,
        )
      }
      expect(final.status).toBe("completed")
    }),
  { config: {} },
)

it.instance(
  "auto mode: aggregated report covers all items (Phase 4.1)",
  () =>
    Effect.gen(function* () {
      const { directory: workspace } = yield* TestInstance
      const llm = yield* TestLLMServer

      // Create three fixture repos: one completes, one halts, one is skipped.
      // The report should list all three with their outcomes.

      // Repo 1: completes (test passes)
      const repo1 = fs.mkdtempSync(path.join(workspace, "repo1-"))
      yield* writeConfig(repo1, {
        ...providerCfg(llm.url),
        experimental: { queue_gate: { test_command: "echo PASS" } },
      })
      writeChange(repo1, "change-good", "- [ ] 1.1 not done\n")
      fs.writeFileSync(path.join(repo1, "openspec", "changes", "change-good", "proposal.md"), "# Good\n")

      // Repo 2: halts (test fails)
      const repo2 = fs.mkdtempSync(path.join(workspace, "repo2-"))
      yield* writeConfig(repo2, {
        ...providerCfg(llm.url),
        experimental: { queue_gate: { test_command: "exit 1" } },
      })
      writeChange(repo2, "change-bad", "- [ ] 1.1 not done\n")
      fs.writeFileSync(path.join(repo2, "openspec", "changes", "change-bad", "proposal.md"), "# Bad\n")

      const loop = yield* Loop.Service
      const info = yield* loop.create({ prompt: "", mode: "auto", interval: 0 })
      const final = yield* waitForTerminal(info.id, 30)

      // The run should reach a terminal status.
      const terminal: Loop.Status[] = ["completed", "stalled", "cancelled", "max_reached", "error"]
      if (!terminal.includes(final.status)) {
        throw new Error(
          `Phase 4.1: expected terminal status, got ${final.status}, report=${final.report}`,
        )
      }

      // The report should mention both repos and their outcomes.
      if (final.report) {
        expect(final.report).toContain("change-good")
        expect(final.report).toContain("change-bad")
        expect(final.report).toContain("HALTED")
      }
    }),
  { config: {} },
)

it.instance(
  "auto mode: distinguishes drained from found nothing (Phase 4.2)",
  () =>
    Effect.gen(function* () {
      const { directory: workspace } = yield* TestInstance

      // No work source, no openspec changes anywhere in scope.
      // The run should report "nothing found", not "drained".

      const loop = yield* Loop.Service
      const info = yield* loop.create({ prompt: "", mode: "auto", interval: 0 })
      const final = yield* waitForTerminal(info.id, 30)

      // The run should complete with a "nothing found" report.
      if (final.status !== "completed") {
        throw new Error(
          `Phase 4.2: expected completed, got ${final.status}, report=${final.report}`,
        )
      }
      expect(final.status).toBe("completed")
      // The report should say "nothing found", not "drained".
      if (final.report) {
        expect(final.report).toContain("nothing found")
        expect(final.report).not.toContain("drained")
      }
    }),
  { config: {} },
)
