// PTY reproduction for task 1.1 of peer-conversation-reliability:
// Verifies that the sidecar's inbound-delivery path does not leak
// Effect-default-runtime log lines to stdout, which would corrupt the
// OpenTUI frame (the TUI runs with externalOutputMode: "passthrough").
//
// The bug was in peer/claude/lifecycle.ts: deliver was forked on the
// DEFAULT runtime (console logger), so every `Effect.log*` in an injected
// turn printed structured lines to stdout — something a JS-level
// process.stdout.write patch would miss because Effect writes directly
// to the fd. The fix is `Effect.runForkWith(context)` (lifecycle.ts:56).
//
// Both halves use the same instrument: a subprocess with piped stdout.
// This catches output however it was written (fd-level, not JS-level).
//
// 1. Positive control: spawns a subprocess that deliberately forks on the
//    default runtime and asserts the leak reaches the pipe. Proves the
//    harness works.
// 2. Regression: spawns a subprocess that forks through
//    `runForkWith(appContext)` (same context the app runtime provides) and
//    asserts no leak. The app's observability layer installs a file logger,
//    so Effect.log* goes to the file, not stdout.
//
// The two halves differ in exactly one variable: runFork vs runForkWith.
// Reverting the fix makes the regression half fail.
//
// Additionally, a source-level guard asserts that lifecycle.ts itself uses
// Effect.runForkWith (not bare Effect.runFork), because the probe's "fixed"
// branch hardcodes its own runForkWith rather than calling the real one.
// See test/tool/send-peer-message-text.test.ts for the same pattern.
//
// Skipped when `claude` is not on PATH — same gate the sidecar itself uses.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "child_process"
import { mkdir, mkdtemp, readFile, readdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { connect } from "net"
import { createTestRenderer } from "@opentui/core/testing"
import { keyFileHash, readKeyFile, readRegistryEntry } from "../../../src/peer/claude/registry"
import {
  claudeCodePresent,
  ensureSidecar,
  isManaged,
  stopAllSidecars,
  stopSidecar,
} from "../../../src/peer/claude/sidecar-manager"

const hasClaudeCode = claudeCodePresent()
const describeIfClaudeCode = hasClaudeCode ? describe : describe.skip

// ── subprocess harness ──────────────────────────────────────────────────────
// Spawns a subprocess that runs the probe script and captures stdout via pipe.
// Both the positive control and regression use this same instrument.
function spawnProbe(mode: "buggy" | "fixed"): Promise<string> {
  return new Promise((resolve, reject) => {
    const script = join(import.meta.dir, "probe-deliver-runtime.mts")
    const child = spawn("bun", [script, mode], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
    })
    const chunks: Buffer[] = []
    child.stdout.on("data", (c: Buffer) => chunks.push(c))
    child.stderr.on("data", () => {}) // discard stderr noise
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8")
      if (code !== 0) reject(new Error(`probe exited ${code}: ${stdout}`))
      else resolve(stdout)
    })
    child.on("error", reject)
  })
}

// ── tests ────────────────────────────────────────────────────────────────────
describeIfClaudeCode("PTY repro: inbound message does not corrupt stdout", () => {
  let claudeConfigDir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    claudeConfigDir = await mkdtemp(join(tmpdir(), "pty-repro-claude-"))
    await mkdir(join(claudeConfigDir, "sessions"), { recursive: true })
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
  })

  afterEach(async () => {
    await stopAllSidecars()
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    await rm(claudeConfigDir, { recursive: true, force: true })
  })

  test("positive control: Effect.runFork on default runtime leaks to stdout", async () => {
    // This test must pass for the harness to be trustworthy. It deliberately
    // uses the buggy path (default runtime) in a subprocess and asserts that
    // a log line reaches the captured stdout pipe — something a JS-level
    // process.stdout.write patch would miss because Effect writes directly
    // to the fd.
    const stdout = await spawnProbe("buggy")
    // Default runtime uses the console logger: `[HH:MM:SS.mmm] ERROR (#N): probe-line`
    expect(stdout).toContain("probe-line")
    expect(stdout).toContain("ERROR")
  }, 10_000)

  test("inbound message delivery leaves stdout clean", async () => {
    // Regression: fork through runForkWith(appContext) — the same context the
    // app runtime provides, which carries the observability layer's file
    // logger. No structured log output should reach stdout.
    const stdout = await spawnProbe("fixed")
    // App runtime uses the observability layer (file logger), so nothing reaches stdout.
    expect(stdout).not.toContain("probe-line")
    expect(stdout).not.toContain("ERROR")
  }, 10_000)

  test("lifecycle.ts uses Effect.runForkWith, not bare Effect.runFork", async () => {
    // The probe's "fixed" branch hardcodes its own runForkWith; this guard
    // asserts the real module uses the technique too. Paired with the
    // experiment above, it closes the gap between "the mechanism works" and
    // "the module uses it".
    const source = await readFile(
      join(import.meta.dir, "../../../src/peer/claude/lifecycle.ts"),
      "utf8",
    )
    expect(source).toContain("Effect.runForkWith(")
    // Match Effect.runFork followed by anything that is not With — catches both
    // the called form (Effect.runFork(...)) and the point-free form
    // (Effect.runFork,) that the original buggy code used. Does not match
    // Effect.runForkWith( — that is the fix.
    expect(source).not.toMatch(/Effect\.runFork(?!With)/)
  }, 5_000)

  test("sidecar deliver cycle leaves stdout clean", async () => {
    // Exercise the real sidecar + deliver path end-to-end. The sidecar spawns,
    // we send a message, it calls our deliver callback, and we stop it.
    // Capture is via process.stdout.write patch — this test verifies no
    // raw JSON frames or sidecar diagnostic bytes leak.
    const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
    const renderer = setup.renderer
    try {
      const capturedChunks: string[] = []
      const originalWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = ((chunk: string | Uint8Array) => {
        capturedChunks.push(String(chunk))
        return originalWrite(chunk)
      }) as typeof process.stdout.write

      const delivered: Array<{ sessionID: string; text: string; msgID?: string; from?: string }> = []
      ensureSidecar(
        { sessionID: "ses_pty_repro", cwd: "/repo", name: "pty-repro" },
        ({ sessionID, text, msgID, from }) => delivered.push({ sessionID, text, msgID, from }),
      )
      expect(isManaged("ses_pty_repro")).toBe(true)

      let pid: number | undefined
      for (let i = 0; i < 100 && !pid; i++) {
        const entries = await readdir(join(claudeConfigDir, "sessions")).catch(() => [])
        const jsonFile = entries.find((e) => e.endsWith(".json"))
        if (jsonFile) pid = Number(jsonFile.replace(".json", ""))
        else await new Promise((r) => setTimeout(r, 50))
      }
      expect(pid).toBeDefined()

      const entry = await readRegistryEntry(pid!)
      expect(entry).toBeDefined()
      const key = await readKeyFile(entry!)
      expect(key).toBeDefined()

      await new Promise<void>((resolve, reject) => {
        const socket = connect(entry!.messagingSocketPath)
        socket.once("connect", () => {
          const frames = [
            { type: "auth", token: key!.peerToken },
            {
              msgV: 1,
              msg_id: "pty-repro-1",
              type: "user",
              message: {
                role: "user",
                content:
                  '<cross-session-message from="uds:/tmp/x.sock" from-name="peer" from-mode="idle">\nhello from PTY repro\n</cross-session-message>',
              },
              priority: "next",
              from: "uds:/tmp/x.sock",
            },
          ]
          socket.write(frames.map((f) => JSON.stringify(f)).join("\n") + "\n", () => socket.end())
        })
        socket.once("close", () => resolve())
        socket.once("error", reject)
      })

      for (let i = 0; i < 100 && delivered.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(delivered).toEqual([
        {
          sessionID: "ses_pty_repro",
          text: "hello from PTY repro",
          msgID: "pty-repro-1",
          from: "uds:/tmp/x.sock",
        },
      ])

      await stopSidecar("ses_pty_repro")
      expect(isManaged("ses_pty_repro")).toBe(false)

      await new Promise((r) => setTimeout(r, 100))

      process.stdout.write = originalWrite
      const captured = capturedChunks.join("")

      // No raw NDJSON frames or sidecar diagnostics should reach stdout.
      expect(captured).not.toContain('"type":"inbound"')
      expect(captured).not.toContain('"type":"ready"')
      expect(captured).not.toContain('"session.id"')
      expect(captured).not.toContain('"claude sidecar"')
    } finally {
      if (!renderer.isDestroyed) renderer.destroy()
    }
  })
})
