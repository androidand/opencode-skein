// The startup race: a sidecar whose parent dies BEFORE the sidecar reads its
// own ppid is already reparented, so the ppid-guard in sidecar-entry.ts can
// never fire and the sidecar survives forever.
//
// The existing orphan test in sidecar-e2e.test.ts:222 waits for the
// registration before killing the parent, so it always exercises the case the
// ppid guard handles. This file covers the case it cannot.
//
// The mechanism was reproduced directly before writing this (Bun 1.3.14,
// macOS): SIGKILL the spawner before the child's first ppid read and the child
// records ppid 1 and never observes a change.
import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { spawn } from "child_process"

const ENTRY = join(import.meta.dir, "../../../src/peer/claude/sidecar-entry.ts")

/**
 * Spawns a sidecar whose parent exits immediately, without waiting for the
 * sidecar to register — so the child is very likely already reparented by the
 * time it evaluates process.ppid. `killAfterMs: 0` makes the race as tight as
 * possible.
 */
async function spawnWithParentExitingAt(opts: { killAfterMs: number; stdin: "pipe" | "ignore" }) {
  const claudeConfigDir = await mkdtemp(join(tmpdir(), "sidecar-race-claude-"))
  await Bun.write(join(claudeConfigDir, "placeholder"), "")
  const socketDir = await mkdtemp(join(tmpdir(), "sidecar-race-sock-"))
  const fakeParent = join(await mkdtemp(join(tmpdir(), "sidecar-race-parent-")), "spawn-and-exit.ts")

  await Bun.write(
    fakeParent,
    `
    import { spawn } from "child_process"
    const child = spawn("bun", ["run", ${JSON.stringify(ENTRY)}], {
      env: { ...process.env },
      stdio: [${JSON.stringify(opts.stdin)}, "pipe", "ignore"],
    })
    child.stdout.on("data", () => {})
    // Expire without signalling: no SIGTERM to the sidecar, so nothing but the
    // sidecar's own detection can end it.
    setTimeout(() => process.exit(0), ${opts.killAfterMs})
    `,
  )

  const proc = spawn("bun", ["run", fakeParent], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      OPENCODE_SIDECAR_OWNER_SESSION_ID: "ses_race_test",
      OPENCODE_SIDECAR_CWD: "/repo",
      OPENCODE_SIDECAR_NAME: "opencode-race-test",
      OPENCODE_SIDECAR_SOCKET_DIR: socketDir,
    },
    stdio: "ignore",
  })
  await new Promise<void>((resolve) => proc.once("exit", () => resolve()))
  return { claudeConfigDir, socketDir }
}

describe("sidecar startup race", () => {
  test("a sidecar whose parent exits before its first ppid read still terminates", async () => {
    // Timing-dependent by nature: to hit the race the parent must die before the
    // child reads its own ppid, and bun's own startup time decides whether that
    // happened. So this retries, and — crucially — only concludes when it has
    // actually OBSERVED the sidecar register and then clean up. An attempt where
    // the sidecar never registered proves nothing and is retried, so this cannot
    // pass by never exercising the race at all.
    const ATTEMPTS = 4
    let sawRegistration = false
    let leaked = false

    for (let attempt = 0; attempt < ATTEMPTS && !leaked; attempt++) {
      const { claudeConfigDir } = await spawnWithParentExitingAt({ killAfterMs: 0, stdin: "pipe" })
      const sessionsDir = join(claudeConfigDir, "sessions")
      const appeared = Date.now() + 8_000
      let registered = false
      while (Date.now() < appeared && !registered) {
        const entries = await readdir(sessionsDir).catch(() => [])
        registered = entries.some((e) => e.endsWith(".json"))
        if (!registered) await new Promise((r) => setTimeout(r, 100))
      }
      if (!registered) {
        await rm(claudeConfigDir, { recursive: true, force: true })
        continue // inconclusive: the race window was not reached this time
      }
      sawRegistration = true

      const gone = Date.now() + 12_000
      let stillThere = true
      while (Date.now() < gone && stillThere) {
        const entries = await readdir(sessionsDir).catch(() => [])
        stillThere = entries.some((e) => e.endsWith(".json"))
        if (stillThere) await new Promise((r) => setTimeout(r, 150))
      }
      leaked = stillThere
      await rm(claudeConfigDir, { recursive: true, force: true })
    }

    // Guard the guard: if no attempt ever registered, the test proved nothing.
    expect(sawRegistration).toBe(true)
    expect(leaked).toBe(false)
  }, 120_000)

  test("stdin: ignore does not kill a sidecar on startup", async () => {
    // Regression guard for the fix itself. With stdio "ignore" the child's stdin
    // is /dev/null, which reads EOF immediately; a naive EOF-means-dead-parent
    // listener would exit a perfectly healthy sidecar the moment it started.
    const claudeConfigDir = await mkdtemp(join(tmpdir(), "sidecar-noeof-claude-"))
    const socketDir = await mkdtemp(join(tmpdir(), "sidecar-noeof-sock-"))

    const child = spawn("bun", ["run", ENTRY], {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        OPENCODE_SIDECAR_OWNER_SESSION_ID: "ses_noeof_test",
        OPENCODE_SIDECAR_CWD: "/repo",
        OPENCODE_SIDECAR_NAME: "opencode-noeof-test",
        OPENCODE_SIDECAR_SOCKET_DIR: socketDir,
      },
      stdio: ["ignore", "pipe", "ignore"],
    })
    let out = ""
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")))

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !out.includes('"type":"ready"')) {
      await new Promise((r) => setTimeout(r, 100))
    }
    // It must still be running and registered after /dev/null EOF has passed.
    expect(out).toContain('"type":"ready"')
    expect(child.exitCode).toBeNull()
    child.kill("SIGKILL")
    await rm(claudeConfigDir, { recursive: true, force: true })
    await rm(socketDir, { recursive: true, force: true })
  }, 20_000)
})