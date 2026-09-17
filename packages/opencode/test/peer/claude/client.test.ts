import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createServer, type Server, type Socket } from "net"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { keyFileHash } from "../../../src/peer/claude/registry"
import { sendClaudeMessage } from "../../../src/peer/claude/client"
import { Process } from "../../../src/util/process"

/** This process's real start time, in the exact format the identity check compares against. */
async function liveProcStart(): Promise<string> {
  const out = await Process.text(["ps", "-o", "lstart=", "-p", String(process.pid)], { env: { TZ: "UTC", LC_ALL: "C" } })
  return out.text.trim()
}

describe("sendClaudeMessage", () => {
  let dir: string
  let previousConfigDir: string | undefined
  let server: Server | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-client-test-"))
    await mkdir(join(dir, "sessions"), { recursive: true })
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    server?.close()
    await rm(dir, { recursive: true, force: true })
  })

  /**
   * Registers against this test process's own real pid and start time, so the
   * pid-identity check is genuinely exercised rather than bypassed.
   */
  async function registerFakePeer(input: {
    pid?: number
    peerProtocol?: number
    socketPath: string
    procStart?: string
    pidDomain?: string
  }) {
    const pid = input.pid ?? process.pid
    await writeFile(
      join(dir, "sessions", `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: "fake-session",
        cwd: "/repo",
        messagingSocketPath: input.socketPath,
        peerProtocol: input.peerProtocol,
      }),
    )
    await writeFile(
      join(dir, "sessions", `${pid}.${keyFileHash(input.socketPath)}.key`),
      JSON.stringify({
        peerToken: "test-token",
        procStart: input.procStart ?? (await liveProcStart()),
        pidDomain: input.pidDomain ?? process.platform,
      }),
    )
    return pid
  }

  test("delivers real frames to a listening socket", async () => {
    const socketPath = join(dir, "test.sock")
    const received: string[] = []
    const serverReceivedAll = new Promise<void>((resolve) => {
      server = createServer((socket: Socket) => {
        socket.on("data", (chunk) => received.push(chunk.toString()))
        socket.on("end", resolve)
      })
    })
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve))
    const pid = await registerFakePeer({ peerProtocol: 1, socketPath })

    const [result] = await Promise.all([
      sendClaudeMessage({
        targetPid: pid,
        fromSessionID: "ses_test",
        fromName: "opencode-skein-test",
        fromMode: "idle",
        text: "hello from a test",
      }),
      serverReceivedAll,
    ])

    expect(result.ok).toBe(true)
    const payload = received.join("")
    const lines = payload.trim().split("\n").map((l) => JSON.parse(l))
    expect(lines[0]).toEqual({ type: "auth", token: "test-token" })
    expect(lines[1].message.content).toContain("hello from a test")
    expect(lines[1].message.content).toContain('from-name="opencode-skein-test"')
  })

  test("refuses a peer advertising an unsupported protocol version", async () => {
    const socketPath = join(dir, "v2.sock")
    await registerFakePeer({ pid: 55, peerProtocol: 2, socketPath, procStart: "x" })
    const result = await sendClaudeMessage({
      targetPid: 55,
      fromSessionID: "ses_test",
      fromName: "n",
      fromMode: "idle",
      text: "x",
    })
    expect(result).toMatchObject({ ok: false, reason: "protocol-mismatch" })
  })

  test("reports not-found for an unregistered pid", async () => {
    const result = await sendClaudeMessage({
      targetPid: 987654,
      fromSessionID: "ses_test",
      fromName: "n",
      fromMode: "idle",
      text: "x",
    })
    expect(result).toMatchObject({ ok: false, reason: "not-found" })
  })

  test("reports unreachable when the registry exists but nothing is listening", async () => {
    const pid = await registerFakePeer({ peerProtocol: 1, socketPath: join(dir, "nothing-listens-here.sock") })
    const result = await sendClaudeMessage({
      targetPid: pid,
      fromSessionID: "ses_test",
      fromName: "n",
      fromMode: "idle",
      text: "x",
    })
    expect(result).toMatchObject({ ok: false, reason: "unreachable" })
  })

  test("refuses an entry that advertises no protocol version at all", async () => {
    const pid = await registerFakePeer({ socketPath: join(dir, "no-protocol.sock") })
    const result = await sendClaudeMessage({
      targetPid: pid,
      fromSessionID: "ses_test",
      fromName: "n",
      fromMode: "idle",
      text: "x",
    })
    expect(result).toMatchObject({ ok: false, reason: "protocol-mismatch" })
  })

  test("refuses when the key file records no process start time — pid reuse cannot be ruled out", async () => {
    const pid = await registerFakePeer({ peerProtocol: 1, socketPath: join(dir, "no-procstart.sock"), procStart: "" })
    const result = await sendClaudeMessage({
      targetPid: pid,
      fromSessionID: "ses_test",
      fromName: "n",
      fromMode: "idle",
      text: "x",
    })
    expect(result).toMatchObject({ ok: false, reason: "identity-mismatch" })
  })

  test("refuses a key file from a foreign pid domain", async () => {
    const pid = await registerFakePeer({
      peerProtocol: 1,
      socketPath: join(dir, "foreign-domain.sock"),
      pidDomain: "some-other-domain",
    })
    const result = await sendClaudeMessage({
      targetPid: pid,
      fromSessionID: "ses_test",
      fromName: "n",
      fromMode: "idle",
      text: "x",
    })
    expect(result).toMatchObject({ ok: false, reason: "identity-mismatch" })
  })

  test("a peer that refuses the connection is never reported as delivered", async () => {
    // What the sidecar's own auth check does on a bad token: destroy the
    // connection. The old client reported any close as a successful delivery.
    const socketPath = join(dir, "refuses.sock")
    server = createServer((socket: Socket) => socket.destroy())
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve))
    const pid = await registerFakePeer({ peerProtocol: 1, socketPath })

    const result = await sendClaudeMessage({
      targetPid: pid,
      fromSessionID: "ses_test",
      fromName: "n",
      fromMode: "idle",
      text: "x",
    })
    expect(result.ok).toBe(false)
  })
})
