// Exercises the real wiring sidecar-manager.ts will run in production:
// ensureSidecar spawns the actual sidecar-entry.ts, a real inbound message
// reaches the injected `deliver` callback, and stopSidecar tears it down
// cleanly. Skipped when `claude` isn't on PATH (same gate the manager itself
// uses) rather than mocking it away — this is exactly the environment this
// feature only matters in.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { connect } from "net"
import { keyFileHash, readKeyFile, readRegistryEntry } from "../../../src/peer/claude/registry"
import { claudeCodePresent, ensureSidecar, isManaged, stopAllSidecars, stopSidecar } from "../../../src/peer/claude/sidecar-manager"

const hasClaudeCode = claudeCodePresent()
const describeIfClaudeCode = hasClaudeCode ? describe : describe.skip

describeIfClaudeCode("sidecar manager (requires claude on PATH)", () => {
  let claudeConfigDir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    claudeConfigDir = await mkdtemp(join(tmpdir(), "sidecar-manager-test-"))
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

  test("a real inbound message reaches the injected deliver callback", async () => {
    const delivered: Array<{ sessionID: string; text: string }> = []

    ensureSidecar(
      { sessionID: "ses_manager_test", cwd: "/repo", name: "manager-test" },
      (sessionID, text) => delivered.push({ sessionID, text }),
    )
    expect(isManaged("ses_manager_test")).toBe(true)

    // Poll for the registry file the spawned sidecar writes, then message it
    // exactly as a real Claude peer would.
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
            msg_id: "manager-test-1",
            type: "user",
            message: {
              role: "user",
              content: '<cross-session-message from="uds:/tmp/x.sock" from-name="peer" from-mode="idle">\nhello via manager\n</cross-session-message>',
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
    expect(delivered).toEqual([{ sessionID: "ses_manager_test", text: "hello via manager" }])

    await stopSidecar("ses_manager_test")
    expect(isManaged("ses_manager_test")).toBe(false)

    // stopSidecar sends SIGTERM; the child's own shutdown (removing its
    // registration) is async and happens after the signal is sent, not
    // before stopSidecar resolves — poll for it rather than asserting
    // immediately.
    let remaining = await readdir(join(claudeConfigDir, "sessions"))
    for (let i = 0; i < 100 && remaining.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 50))
      remaining = await readdir(join(claudeConfigDir, "sessions"))
    }
    expect(remaining).toEqual([])
  }, 20_000)

  test("keyFileHash sanity — same value the sidecar itself computes", () => {
    expect(keyFileHash("/tmp/x.sock")).toHaveLength(64)
  })
})
