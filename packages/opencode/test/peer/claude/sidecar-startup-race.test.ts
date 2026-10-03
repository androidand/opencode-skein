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

describe("sidecar startup race", () => {
  test("stdin EOF alone terminates the sidecar while its parent is alive", async () => {
    // This is the test that makes the EOF guard *provable*, and it exists because
    // the timing test above cannot: if the parent dies after the child reads
    // process.ppid, the pre-existing ppid guard terminates the sidecar anyway, so
    // "the sidecar terminated" does not imply "the EOF guard terminated it".
    //
    // Here the parent — this test process — stays alive for the whole test, so
    // `process.ppid` never changes and the ppid guard cannot fire. Closing only
    // the stdin pipe gives the child EOF and nothing else. If the sidecar exits
    // and unregisters, the EOF guard is the only possible cause.
    const claudeConfigDir = await mkdtemp(join(tmpdir(), "sidecar-eof-claude-"))
    const socketDir = await mkdtemp(join(tmpdir(), "sidecar-eof-sock-"))

    const child = spawn("bun", ["run", ENTRY], {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        OPENCODE_SIDECAR_OWNER_SESSION_ID: "ses_eof_test",
        OPENCODE_SIDECAR_CWD: "/repo",
        OPENCODE_SIDECAR_NAME: "opencode-eof-test",
        OPENCODE_SIDECAR_SOCKET_DIR: socketDir,
      },
      stdio: ["pipe", "pipe", "ignore"],
    })
    let out = ""
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")))

    const ready = Date.now() + 15_000
    while (Date.now() < ready && !out.includes('"type":"ready"')) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(out).toContain('"type":"ready"')
    expect(child.exitCode).toBeNull()

    // The only signal the child will get. Its parent is this process and stays
    // right here, alive, so no reparenting can occur.
    child.stdin?.end()

    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
    const won = await Promise.race([
      exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
    ])
    expect(won).not.toBeNull()
    expect(child.exitCode).not.toBeNull()

    // Unregisters on the way out, so the next boot's sweep finds nothing to do.
    const entries = await readdir(join(claudeConfigDir, "sessions")).catch(() => [])
    expect(entries.some((e) => e.endsWith(".json"))).toBe(false)

    child.kill("SIGKILL")
    await rm(claudeConfigDir, { recursive: true, force: true })
    await rm(socketDir, { recursive: true, force: true })
  }, 45_000)

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