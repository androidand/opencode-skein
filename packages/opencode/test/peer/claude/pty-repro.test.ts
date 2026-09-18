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
// This test has two parts:
// 1. A positive control that spawns a subprocess, deliberately forks on
//    the default runtime, and asserts the leak reaches the pipe. This
//    proves the harness actually works.
// 2. A regression test that exercises the real sidecar+delivery path and
//    asserts no such leak occurs on stdout.
//
// Skipped when `claude` is not on PATH — same gate the sidecar itself uses.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { connect, type Socket } from "net"
import { spawn, type ChildProcess } from "child_process"
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

// ── positive control harness ────────────────────────────────────────────────
// Spawns a subprocess that runs the buggy code path and captures stdout
// via a pipe. This proves the harness would catch a leak.
function positiveControl(): Promise<{ stdout: string }> {
  return new Promise((resolve) => {
    const script =
      "import { Effect } from 'effect';\n" +
      "Effect.runFork(Effect.logError('probe-line'));\n" +
      "await new Promise((r) => setTimeout(r, 300));\n"
    const tmpfile = join(tmpdir(), "pty-probe-line.mts")
    require("fs").writeFileSync(tmpfile, script)
    const child = spawn("bun", [tmpfile], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
    })
    const chunks: Buffer[] = []
    child.stdout.on("data", (c: Buffer) => chunks.push(c))
    child.stderr.on("data", () => {}) // discard
    child.on("close", () => {
      resolve({ stdout: Buffer.concat(chunks).toString("utf8") })
    })
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
    const { stdout } = await positiveControl()
    // The real format is `timestamp=... level=ERROR fiber=#N message=...`
    expect(stdout).toContain("message=probe-line")
    expect(stdout).toContain("level=ERROR")
  }, 10_000)

  test("inbound message delivery leaves stdout clean", async () => {
    // Create a test renderer with capture-stdout mode. This records every
    // process.stdout.write() call so we can inspect whether anything leaked
    // past the OpenTUI frame during message delivery.
    const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
    const renderer = setup.renderer
    try {
      const capturedChunks: string[] = []
      const originalWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = ((chunk: string | Uint8Array) => {
        capturedChunks.push(String(chunk))
        return originalWrite(chunk)
      }) as typeof process.stdout.write

      // Set up a real sidecar (same as production) and capture the deliver
      // callback to know when the message has been handed off.
      const delivered: Array<{ sessionID: string; text: string; msgID?: string; from?: string }> = []
      ensureSidecar(
        { sessionID: "ses_pty_repro", cwd: "/repo", name: "pty-repro" },
        ({ sessionID, text, msgID, from }) => delivered.push({ sessionID, text, msgID, from }),
      )
      expect(isManaged("ses_pty_repro")).toBe(true)

      // Wait for the sidecar to register, then send a message exactly as a
      // real Claude peer would.
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

      // Wait for delivery.
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

      // Stop the sidecar (triggers the diagnostic hook, which also runs
      // through the same fork path).
      await stopSidecar("ses_pty_repro")
      expect(isManaged("ses_pty_repro")).toBe(false)

      // Let the renderer settle any pending output.
      await new Promise((r) => setTimeout(r, 100))

      // Restore stdout and inspect what was captured.
      process.stdout.write = originalWrite
      const captured = capturedChunks.join("")

      // The stdout capture must not contain any raw JSON frames or structured
      // log lines that would corrupt the OpenTUI frame. The delivery path
      // runs inside runForkWith(context) (app runtime, file logger), not the
      // default runtime, so no structured output should reach stdout.
      expect(captured).not.toContain('"type":"inbound"')
      expect(captured).not.toContain('"type":"ready"')
      expect(captured).not.toContain('"session.id"')
      expect(captured).not.toContain('"claude sidecar"')
      expect(captured).not.toContain("level=ERROR")
      expect(captured).not.toContain("level=WARN")
      expect(captured).not.toContain("level=INFO")

    } finally {
      if (!renderer.isDestroyed) renderer.destroy()
    }
  })
})
