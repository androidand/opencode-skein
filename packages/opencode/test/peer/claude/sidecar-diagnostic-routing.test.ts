// Regression for peer-conversation-reliability 1.2: sidecar diagnostics
// (stderr lines and abnormal exits) go through the `diagnostic` hook so the
// caller can route them to the application logger instead of the TUI's shared
// console. Without this test the manager could silently drain stderr again.
//
// Gated on `claude` being on PATH, same gate the manager itself uses and the
// existing sidecar-manager.test.ts relies on — a sidecar is the real object
// here and there is no cheap fake child. The test observes that an abnormal
// exit (SIGKILL) is reported through the hook, proving diagnostics are
// captured rather than silently drained.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  claudeCodePresent,
  ensureSidecar,
  isManaged,
  stopAllSidecars,
  stopSidecar,
} from "../../../src/peer/claude/sidecar-manager"

const hasClaudeCode = claudeCodePresent()
const describeIfClaudeCode = hasClaudeCode ? describe : describe.skip

describeIfClaudeCode("sidecar diagnostic routing (task 1.2)", () => {
  let claudeConfigDir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    claudeConfigDir = await mkdtemp(join(tmpdir(), "sidecar-diag-test-"))
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

  test("abnormal sidecar exit is reported through the diagnostic hook", async () => {
    const diagnostics: string[] = []

    ensureSidecar(
      { sessionID: "ses_diag_test", cwd: "/repo", name: "diag-test" },
      () => undefined,
      { diagnostic: (message: string) => diagnostics.push(message) },
    )
    expect(isManaged("ses_diag_test")).toBe(true)

    // Wait for the registry file the spawned sidecar writes, then find its pid.
    let pid: number | undefined
    for (let i = 0; i < 100 && !pid; i++) {
      const entries = await readdir(join(claudeConfigDir, "sessions")).catch(() => [])
      const jsonFile = entries.find((e) => e.endsWith(".json"))
      if (jsonFile) pid = Number(jsonFile.replace(".json", ""))
      else await new Promise((r) => setTimeout(r, 50))
    }
    expect(pid).toBeDefined()

    // Kill with SIGKILL so the exit is abnormal (signal set, code null) —
    // exactly the case the spec requires to be logged with code and signal.
    if (pid !== undefined) process.kill(pid!, "SIGKILL")

    // Poll for the exit line rather than racing the async exit handler.
    let exitLine: string | undefined
    for (let i = 0; i < 100 && !exitLine; i++) {
      exitLine = diagnostics.find((d) => d.includes("exited with"))
      if (!exitLine) await new Promise((r) => setTimeout(r, 50))
    }

    // The hook must have captured the abnormal exit (not silently drained).
    // A SIGKILL reports code null + signal SIGKILL; the log must name the signal.
    expect(exitLine).toBeDefined()
    expect(exitLine?.includes("SIGKILL")).toBe(true)

    // stopSidecar after the child is already gone should be a no-op, not throw.
    expect(() => stopSidecar("ses_diag_test")).not.toThrow()
  }, 20_000)
})
