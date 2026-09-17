import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { keyFileHash } from "../../../src/peer/claude/registry"
import {
  MANAGED_BY,
  listManagedPids,
  removeSidecarRegistration,
  sweepStaleSidecars,
  writeSidecarRegistration,
  type SidecarRegistration,
} from "../../../src/peer/claude/sidecar-registry"

describe("sidecar registry", () => {
  let dir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sidecar-registry-test-"))
    await mkdir(join(dir, "sessions"), { recursive: true })
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    await rm(dir, { recursive: true, force: true })
  })

  function registration(over: Partial<SidecarRegistration> = {}): SidecarRegistration {
    return {
      pid: 12345,
      sessionId: "fake-uuid",
      cwd: "/repo",
      startedAt: 1000,
      procStart: "Sat Sep  5 15:15:11 2026",
      peerProtocol: 1,
      messagingSocketPath: "/tmp/opencode-cc-socks/12345.sock",
      name: "opencode-sidecar",
      status: "idle",
      managedBy: MANAGED_BY,
      ownerSessionID: "ses_real_opencode_session",
      ...over,
    }
  }

  test("writes a registry file and a hashed key file, tagged with the marker", async () => {
    await writeSidecarRegistration(registration(), "test-token")
    const written = JSON.parse(await readFile(join(dir, "sessions", "12345.json"), "utf8"))
    expect(written.managedBy).toBe("opencode-skein")
    expect(written.ownerSessionID).toBe("ses_real_opencode_session")

    const hash = keyFileHash("/tmp/opencode-cc-socks/12345.sock")
    const key = JSON.parse(await readFile(join(dir, "sessions", `12345.${hash}.key`), "utf8"))
    expect(key.peerToken).toBe("test-token")
  })

  test("removeSidecarRegistration deletes exactly its own two files", async () => {
    await writeSidecarRegistration(registration(), "test-token")
    await removeSidecarRegistration(12345, "/tmp/opencode-cc-socks/12345.sock")
    const remaining = await readdir(join(dir, "sessions"))
    expect(remaining).toEqual([])
  })

  test("sweep removes a marked entry whose pid is dead", async () => {
    await writeSidecarRegistration(registration({ pid: 1 }), "token-1")
    const removed = await sweepStaleSidecars(() => false)
    expect(removed).toContain("1.json")
    expect(await readdir(join(dir, "sessions"))).toEqual([])
  })

  test("sweep leaves a marked entry whose pid is alive", async () => {
    await writeSidecarRegistration(registration({ pid: 2 }), "token-2")
    const removed = await sweepStaleSidecars(() => true)
    expect(removed).toEqual([])
    expect(await readdir(join(dir, "sessions"))).toHaveLength(2) // .json + .key
  })

  test("sweep NEVER touches an entry without the marker, even with a dead pid — could be a real Claude session", async () => {
    await writeFile(
      join(dir, "sessions", "999.json"),
      JSON.stringify({ pid: 999, sessionId: "real-claude-session", cwd: "/somewhere", messagingSocketPath: "/tmp/cc-socks/999.sock" }),
    )
    const removed = await sweepStaleSidecars(() => false)
    expect(removed).toEqual([])
    expect(await readdir(join(dir, "sessions"))).toContain("999.json")
  })

  test("sweep tolerates a malformed registry file among real ones", async () => {
    await writeFile(join(dir, "sessions", "bad.json"), "{not json")
    await writeSidecarRegistration(registration({ pid: 3 }), "token-3")
    const removed = await sweepStaleSidecars(() => false)
    expect(removed).toContain("3.json")
    // The malformed file is left alone, not thrown on and not deleted.
    expect(await readdir(join(dir, "sessions"))).toContain("bad.json")
  })

  test("an empty sessions directory sweeps cleanly", async () => {
    expect(await sweepStaleSidecars(() => false)).toEqual([])
  })

  test("listManagedPids returns only our own marked pids, not a real Claude entry alongside them", async () => {
    await writeSidecarRegistration(registration({ pid: 10 }), "token-10")
    await writeFile(
      join(dir, "sessions", "20.json"),
      JSON.stringify({ pid: 20, sessionId: "real-claude", cwd: "/x", messagingSocketPath: "/tmp/cc-socks/20.sock" }),
    )
    const pids = await listManagedPids()
    expect(pids.has(10)).toBe(true)
    expect(pids.has(20)).toBe(false)
  })
})
