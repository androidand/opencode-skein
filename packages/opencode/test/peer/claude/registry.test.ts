import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { keyFileHash, readKeyFile, readRegistryEntry, verifyProcessIdentity } from "../../../src/peer/claude/registry"
import { Process } from "../../../src/util/process"

describe("claude registry", () => {
  let dir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-registry-test-"))
    await mkdir(join(dir, "sessions"), { recursive: true })
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    await rm(dir, { recursive: true, force: true })
  })

  test("keyFileHash is sha256(socketPath), lowercase hex — confirmed exactly in findings.md", () => {
    // Precomputed independently: `printf '%s' "/tmp/cc-socks/3866.sock" | shasum -a 256`.
    expect(keyFileHash("/tmp/cc-socks/3866.sock")).toBe(
      "cd66ce3852e3912861737506020eacd4d2b789ab8a6af3e593a936d481217db6",
    )
  })

  test("reads a well-formed registry entry", async () => {
    await writeFile(
      join(dir, "sessions", "3866.json"),
      JSON.stringify({
        pid: 3866,
        sessionId: "d1d25a93-76b4-4b14-8fdf-3a9896202a4c",
        cwd: "/repo",
        messagingSocketPath: "/tmp/cc-socks/3866.sock",
        peerProtocol: 1,
      }),
    )
    const entry = await readRegistryEntry(3866)
    expect(entry?.sessionId).toBe("d1d25a93-76b4-4b14-8fdf-3a9896202a4c")
    expect(entry?.messagingSocketPath).toBe("/tmp/cc-socks/3866.sock")
  })

  test("a missing registry file resolves to undefined, never throws", async () => {
    expect(await readRegistryEntry(999999)).toBeUndefined()
  })

  test("malformed JSON resolves to undefined, never throws", async () => {
    await writeFile(join(dir, "sessions", "1.json"), "{not json")
    expect(await readRegistryEntry(1)).toBeUndefined()
  })

  test("reads the key file at the hashed sibling path, and only that path", async () => {
    const socketPath = "/tmp/cc-socks/42.sock"
    const hash = keyFileHash(socketPath)
    await writeFile(
      join(dir, "sessions", `42.${hash}.key`),
      JSON.stringify({ peerToken: "abc123", procStart: "Sat Sep  5 15:15:11 2026", pidDomain: "darwin" }),
    )
    const key = await readKeyFile({ pid: 42, sessionId: "s", cwd: "/", messagingSocketPath: socketPath })
    expect(key?.peerToken).toBe("abc123")
  })

  test("a missing key file resolves to undefined, never throws", async () => {
    const key = await readKeyFile({ pid: 42, sessionId: "s", cwd: "/", messagingSocketPath: "/tmp/cc-socks/42.sock" })
    expect(key).toBeUndefined()
  })

  test("verifyProcessIdentity confirms a live process's real procStart", async () => {
    const out = await Process.text(["ps", "-o", "lstart=", "-p", String(process.pid)], {
      env: { TZ: "UTC", LC_ALL: "C" },
    })
    expect(await verifyProcessIdentity(process.pid, out.text.trim())).toBe(true)
  })

  test("verifyProcessIdentity refuses a mismatched procStart", async () => {
    expect(await verifyProcessIdentity(process.pid, "Sat Sep  5 00:00:00 2020")).toBe(false)
  })

  test("verifyProcessIdentity refuses a pid that is not running", async () => {
    expect(await verifyProcessIdentity(999999, "Sat Sep  5 15:15:11 2026")).toBe(false)
  })
})
