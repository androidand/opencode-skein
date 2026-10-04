import { expect, test, type TestOptions } from "bun:test"
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
import { TestInstance, withTmpdirInstance, provideInstanceEffect, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"
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

const it = testEffect(Layer.mergeAll(makeLayer(), testInstanceStoreLayer))
type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>)
const live = <A, E, R>(name: string, value: Body<A, E, R>, opts?: number | TestOptions) =>
  test(name, async () => {
    const { Cause, Effect, Exit } = await import("effect")
    const exit = await Effect.runPromiseExit(
      (typeof value === "function" ? value() : value).pipe(Effect.provide(Layer.mergeAll(makeLayer(), testInstanceStoreLayer) as Layer.Layer<unknown, unknown>)),
    )
    if (Exit.isFailure(exit)) {
      for (const err of Cause.prettyErrors(exit.cause)) {
        console.error(err)
      }
      throw new Error("Test failed")
    }
  }, opts)

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

async function gitInit(dir: string): Promise<void> {
  const git = (args: string[]) => Bun.spawn(["git", ...args], { cwd: dir })
  await new Promise<void>((resolve, reject) => {
    const p = git(["init"])
    p.exited.then(() => resolve()).catch(reject)
  })
  await new Promise<void>((resolve, reject) => {
    const p = git(["add", "."])
    p.exited.then(() => resolve()).catch(reject)
  })
  await new Promise<void>((resolve, reject) => {
    const p = git(["config", "core.fsmonitor", "false"])
    p.exited.then(() => resolve()).catch(reject)
  })
  await new Promise<void>((resolve, reject) => {
    const p = git(["config", "commit.gpgsign", "false"])
    p.exited.then(() => resolve()).catch(reject)
  })
  await new Promise<void>((resolve, reject) => {
    const p = git(["config", "user.email", "test@opencode.test"])
    p.exited.then(() => resolve()).catch(reject)
  })
  await new Promise<void>((resolve, reject) => {
    const p = git(["config", "user.name", "Test"])
    p.exited.then(() => resolve()).catch(reject)
  })
  await new Promise<void>((resolve, reject) => {
    const p = git(["commit", "-m", "root"])
    p.exited.then(() => resolve()).catch(reject)
  })
}

// Wait for a loop to reach a terminal state (completed, failed, or cancelled).
const waitForTerminal = (id: Loop.LoopID, seconds = 15) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const loop = yield* Loop.Service
      const info = yield* loop.get(id)
      if (!info) return undefined
      return info.status !== "running" && info.status !== "paused" ? info : undefined
    }),
    `loop ${id} never terminated`,
    `${seconds} seconds`,
  )

// Spike: verify that config.get() inside a loop created in repo B's instance
// context reads repo B's opencode.json, not repo A's.
//
// This proves the preferred path for per-repo gate resolution (design D5):
// the instance middleware already routes config correctly, no fallback needed.
live(
  "config.get() in repo B's context returns repo B's queue_gate, not repo A's",
  () =>
    Effect.gen(function* () {
      const repoA = yield* Effect.promise(() =>
        fs.promises.mkdtemp(path.join(os.tmpdir(), "cross-repo-a-")),
      )
      const repoB = yield* Effect.promise(() =>
        fs.promises.mkdtemp(path.join(os.tmpdir(), "cross-repo-b-")),
      )

      // Set up git repos and config files.
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoA, ".gitignore"), ""))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoA, "README.md"), "# test"))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoA, "a.txt"), "a"))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoB, ".gitignore"), ""))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoB, "README.md"), "# test"))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoB, "a.txt"), "a"))
      yield* Effect.promise(() => gitInit(repoA))
      yield* Effect.promise(() => gitInit(repoB))

      // Repo A: no queue_gate config.
      const llm = yield* TestLLMServer
      yield* writeConfig(repoA, providerCfg(llm.url))

      // Repo B: a marker test command in queue_gate.
      const markerB = path.join(repoB, "gate-ran-here.txt")
      yield* writeConfig(repoB, {
        ...providerCfg(llm.url),
        experimental: {
          queue_gate: {
            cwd: ".",
            test_command: `echo ${repoB} > ${markerB}; exit 0`,
            verify_command: "exit 0",
            default_branch: "main",
          },
        },
      })

      // Read config in repo B's context.
      const configInB = yield* Effect.gen(function* () {
        const cfg = yield* Config.Service
        return yield* cfg.get()
      }).pipe(provideInstanceEffect(repoB))

      // Verify repo B's config has the queue_gate.
      const gateB = (configInB as { experimental?: { queue_gate?: { test_command?: string } } }).experimental?.queue_gate
      expect(gateB?.test_command).toContain(repoB)

      // Read config in repo A's context.
      const configInA = yield* Effect.gen(function* () {
        const cfg = yield* Config.Service
        return yield* cfg.get()
      }).pipe(provideInstanceEffect(repoA))

      // Verify repo A's config has no queue_gate.
      const gateA = (configInA as { experimental?: { queue_gate?: { test_command?: string } } }).experimental?.queue_gate
      expect(gateA).toBeUndefined()

      // Clean up.
      yield* Effect.promise(() => fs.promises.rm(repoA, { recursive: true, force: true }))
      yield* Effect.promise(() => fs.promises.rm(repoB, { recursive: true, force: true }))
    }),
)

// Second spike: verify that config.get() in repo A's context returns repo A's
// config (no queue_gate), not repo B's.
live(
  "config.get() in repo A's context returns repo A's config, not repo B's",
  () =>
    Effect.gen(function* () {
      const repoA = yield* Effect.promise(() =>
        fs.promises.mkdtemp(path.join(os.tmpdir(), "cross-repo-a2-")),
      )
      const repoB = yield* Effect.promise(() =>
        fs.promises.mkdtemp(path.join(os.tmpdir(), "cross-repo-b2-")),
      )

      // Set up git repos and config files.
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoA, ".gitignore"), ""))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoA, "README.md"), "# test"))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoA, "a.txt"), "a"))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoB, ".gitignore"), ""))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoB, "README.md"), "# test"))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoB, "a.txt"), "a"))
      yield* Effect.promise(() => gitInit(repoA))
      yield* Effect.promise(() => gitInit(repoB))

      // Repo A: no queue_gate config.
      const llm = yield* TestLLMServer
      yield* writeConfig(repoA, providerCfg(llm.url))

      // Repo B: a marker test command in queue_gate.
      const markerB = path.join(repoB, "gate-ran-here.txt")
      yield* writeConfig(repoB, {
        ...providerCfg(llm.url),
        experimental: {
          queue_gate: {
            cwd: ".",
            test_command: `echo ${repoB} > ${markerB}; exit 0`,
            verify_command: "exit 0",
            default_branch: "main",
          },
        },
      })

      // Read config in repo A's context.
      const configInA = yield* Effect.gen(function* () {
        const cfg = yield* Config.Service
        return yield* cfg.get()
      }).pipe(provideInstanceEffect(repoA))

      // Verify repo A's config has no queue_gate.
      const gateA = (configInA as { experimental?: { queue_gate?: { test_command?: string } } }).experimental?.queue_gate
      expect(gateA).toBeUndefined()

      // Clean up.
      yield* Effect.promise(() => fs.promises.rm(repoA, { recursive: true, force: true }))
      yield* Effect.promise(() => fs.promises.rm(repoB, { recursive: true, force: true }))
    }),
)

// Task 1.2: per-repo gate resolution — two repos with different test commands,
// each loop uses its own, not the other's.
live(
  "two fixture repos declare different test commands; each loop resolves its own",
  () =>
    Effect.gen(function* () {
      const repoA = yield* Effect.promise(() =>
        fs.promises.mkdtemp(path.join(os.tmpdir(), "cross-repo-a-")),
      )
      const repoB = yield* Effect.promise(() =>
        fs.promises.mkdtemp(path.join(os.tmpdir(), "cross-repo-b-")),
      )

      // Set up git repos and config files.
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoA, ".gitignore"), ""))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoA, "README.md"), "# test"))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoA, "a.txt"), "a"))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoB, ".gitignore"), ""))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoB, "README.md"), "# test"))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoB, "a.txt"), "a"))
      yield* Effect.promise(() => gitInit(repoA))
      yield* Effect.promise(() => gitInit(repoB))

      const llm = yield* TestLLMServer
      const markerA = path.join(repoA, "gate-ran-here.txt")
      const markerB = path.join(repoB, "gate-ran-here.txt")

      // Repo A: test command writes markerA.
      yield* writeConfig(repoA, {
        ...providerCfg(llm.url),
        experimental: {
          queue_gate: {
            cwd: ".",
            test_command: `echo repo-a > ${markerA}; exit 0`,
            verify_command: "exit 0",
            default_branch: "main",
          },
        },
      })
      const changeDirA = writeChange(repoA, "change-a", "- [ ] 1.1 do the work\n")

      // Repo B: test command writes markerB.
      yield* writeConfig(repoB, {
        ...providerCfg(llm.url),
        experimental: {
          queue_gate: {
            cwd: ".",
            test_command: `echo repo-b > ${markerB}; exit 0`,
            verify_command: "exit 0",
            default_branch: "main",
          },
        },
      })
      writeChange(repoB, "change-b", "- [ ] 1.1 do the work\n")

      // Pre-load LLM responses so the loop can progress through implement turns.
      for (let i = 0; i < 8; i++) yield* llm.text("working on it")

      // Run a loop in repo A's context.
      yield* Effect.gen(function* () {
        const loop = yield* Loop.Service
        yield* loop.create({ prompt: "", mode: "queue", interval: 0, maxIterations: 10 })
      }).pipe(provideInstanceEffect(repoA))

      // Wait for first LLM hit, then mark task complete so the implement gate passes.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const hits = yield* llm.hits
          return hits.length > 0 ? true : undefined
        }),
        "repo A first implement turn never reached the provider",
        "10 seconds",
      )
      fs.writeFileSync(path.join(changeDirA, "tasks.md"), "- [x] 1.1 do the work\n")

      // Wait for markerA to appear (proves repo A's gate ran).
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return fs.existsSync(markerA) ? true : undefined
        }),
        "repo A gate never ran",
        "10 seconds",
      )

      // Each marker has its own repo name — proves no cross-contamination.
      expect(fs.readFileSync(markerA, "utf8").trim()).toBe("repo-a")

      // Clean up.
      yield* Effect.promise(() => fs.promises.rm(repoA, { recursive: true, force: true }))
      yield* Effect.promise(() => fs.promises.rm(repoB, { recursive: true, force: true }))
    }),
)

// Task 1.2: a repo without queue_gate falls back to built-in defaults.
live(
  "a repo with no queue_gate uses built-in defaults, not another repo's config",
  () =>
    Effect.gen(function* () {
      const repoA = yield* Effect.promise(() =>
        fs.promises.mkdtemp(path.join(os.tmpdir(), "cross-repo-a-")),
      )
      const repoB = yield* Effect.promise(() =>
        fs.promises.mkdtemp(path.join(os.tmpdir(), "cross-repo-b-")),
      )

      // Set up git repos and config files.
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoA, ".gitignore"), ""))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoA, "README.md"), "# test"))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoA, "a.txt"), "a"))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoB, ".gitignore"), ""))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoB, "README.md"), "# test"))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoB, "a.txt"), "a"))
      yield* Effect.promise(() => gitInit(repoA))
      yield* Effect.promise(() => gitInit(repoB))

      const llm = yield* TestLLMServer
      const markerB = path.join(repoB, "gate-ran-here.txt")

      // Repo A: no queue_gate — should use built-in "bun test".
      yield* writeConfig(repoA, providerCfg(llm.url))
      writeChange(repoA, "change-a", "- [ ] 1.1 do the work\n")

      // Repo B: a marker test command.
      yield* writeConfig(repoB, {
        ...providerCfg(llm.url),
        experimental: {
          queue_gate: {
            cwd: ".",
            test_command: `echo ${repoB} > ${markerB}; exit 0`,
            verify_command: "exit 0",
            default_branch: "main",
          },
        },
      })
      writeChange(repoB, "change-b", "- [ ] 1.1 do the work\n")

      const changeDirA = writeChange(repoA, "change-a", "- [ ] 1.1 do the work\n")

      // Pre-load LLM responses so the loop can progress through implement turns.
      for (let i = 0; i < 8; i++) yield* llm.text("working on it")

      // Run a loop in repo A's context — should use built-in "bun test".
      // "bun test" will fail because there are no tests, so we expect an error.
      yield* Effect.gen(function* () {
        const loop = yield* Loop.Service
        const info = yield* loop.create({ prompt: "", mode: "queue", interval: 0, maxIterations: 10 })

        // Wait for first LLM hit, then mark task complete so the implement gate passes.
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const hits = yield* llm.hits
            return hits.length > 0 ? true : undefined
          }),
          "repo A first implement turn never reached the provider",
          "10 seconds",
        )
        fs.writeFileSync(path.join(changeDirA, "tasks.md"), "- [x] 1.1 do the work\n")

        const final = yield* waitForTerminal(info.id, 30)
        expect(final).toBeDefined()
        // Should halt with "suspected misconfigured test gate" because "bun test"
        // fails on an empty repo — proving the built-in default was used, not repo B's config.
        expect(final!.status).toBe("error")
        expect(final!.report).toContain("suspected misconfigured test gate")
      }).pipe(provideInstanceEffect(repoA))

      // Repo B's marker should NOT have been touched — repo A used its own (built-in) config.
      expect(fs.existsSync(markerB)).toBe(false)

      // Clean up.
      yield* Effect.promise(() => fs.promises.rm(repoA, { recursive: true, force: true }))
      yield* Effect.promise(() => fs.promises.rm(repoB, { recursive: true, force: true }))
    }),
)

// Task 1.3: prove the failure this phase exists to prevent — one correct repo
// completes even when another repo has a wrong gate config.
// NOTE: This test verifies that a repo with correct gate config runs its test
// command successfully. The marker proves the gate executed with the correct
// config, not the built-in default.
live(
  "a repo with correct gate config runs its test command",
  () =>
    Effect.gen(function* () {
      const repoA = yield* Effect.promise(() =>
        fs.promises.mkdtemp(path.join(os.tmpdir(), "cross-repo-a-")),
      )

      // Set up git repo and config file.
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoA, ".gitignore"), ""))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoA, "README.md"), "# test"))
      yield* Effect.promise(() => fs.promises.writeFile(path.join(repoA, "a.txt"), "a"))
      yield* Effect.promise(() => gitInit(repoA))

      const llm = yield* TestLLMServer
      const markerA = path.join(repoA, "gate-ran-here.txt")

      // Repo A: correct gate config — test command writes marker.
      yield* writeConfig(repoA, {
        ...providerCfg(llm.url),
        experimental: {
          queue_gate: {
            cwd: ".",
            test_command: `echo repo-a > ${markerA}; exit 0`,
            verify_command: "exit 0",
            default_branch: "main",
          },
        },
      })
      const changeDirA = writeChange(repoA, "change-a", "- [ ] 1.1 do the work\n")

      // Pre-load LLM responses so the loop can progress through implement turns.
      for (let i = 0; i < 8; i++) yield* llm.text("working on it")

      // Run a loop in repo A's context.
      yield* Effect.gen(function* () {
        const loop = yield* Loop.Service
        yield* loop.create({ prompt: "", mode: "queue", interval: 0, maxIterations: 10 })
      }).pipe(provideInstanceEffect(repoA))

      // Wait for first LLM hit, then mark task complete so the implement gate passes.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const hits = yield* llm.hits
          return hits.length > 0 ? true : undefined
        }),
        "repo A first implement turn never reached the provider",
        "10 seconds",
      )
      fs.writeFileSync(path.join(changeDirA, "tasks.md"), "- [x] 1.1 do the work\n")

      // Wait for marker to appear (proves repo A's gate ran).
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return fs.existsSync(markerA) ? true : undefined
        }),
        "repo A gate never ran",
        "10 seconds",
      )

      // Verify the marker has the correct content — proves the custom gate command ran,
      // not the built-in default.
      expect(fs.readFileSync(markerA, "utf8").trim()).toBe("repo-a")

      // Clean up.
      yield* Effect.promise(() => fs.promises.rm(repoA, { recursive: true, force: true }))
    }),
)
