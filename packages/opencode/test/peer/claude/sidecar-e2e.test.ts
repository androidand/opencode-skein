// End-to-end: spawns the REAL sidecar-entry.ts as a genuinely separate
// process (exactly what sidecar-manager.ts spawns in production), connects
// to it as a fake Claude Code peer would, and drives the full inbound path:
// registration -> real socket -> auth -> message -> envelope-stripped event
// on stdout -> clean shutdown -> registration removed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { connect } from "net"
import { spawn, type ChildProcess } from "child_process"
import { keyFileHash } from "../../../src/peer/claude/registry"
import { formatPeerEnvelope } from "../../../src/peer/envelope"

const ENTRY = join(import.meta.dir, "../../../src/peer/claude/sidecar-entry.ts")

describe("sidecar end-to-end", () => {
  let claudeConfigDir: string
  let socketDir: string
  let previousConfigDir: string | undefined
  let child: ChildProcess | undefined

  beforeEach(async () => {
    claudeConfigDir = await mkdtemp(join(tmpdir(), "sidecar-e2e-claude-"))
    await mkdir(join(claudeConfigDir, "sessions"), { recursive: true })
    socketDir = await mkdtemp(join(tmpdir(), "sidecar-e2e-sock-"))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  })

  afterEach(async () => {
    if (child && !child.killed) {
      child.kill("SIGKILL")
    }
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    await rm(claudeConfigDir, { recursive: true, force: true })
    await rm(socketDir, { recursive: true, force: true })
  })

  function waitForLine(stream: NodeJS.ReadableStream, predicate: (event: any) => boolean, timeoutMs = 10_000): Promise<any> {
    return new Promise((resolve, reject) => {
      let buffer = ""
      const timer = setTimeout(() => reject(new Error("timed out waiting for sidecar event")), timeoutMs)
      stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8")
        let idx: number
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            if (predicate(event)) {
              clearTimeout(timer)
              resolve(event)
              return
            }
          } catch {
            // ignore non-JSON stray output
          }
        }
      })
    })
  }

  test("registers, accepts a real inbound message, and cleans up on shutdown", async () => {
    child = spawn("bun", ["run", ENTRY], {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        OPENCODE_SIDECAR_OWNER_SESSION_ID: "ses_test_owner",
        OPENCODE_SIDECAR_CWD: "/repo",
        OPENCODE_SIDECAR_NAME: "opencode-e2e-test",
        OPENCODE_SIDECAR_SOCKET_DIR: socketDir,
      },
      stdio: ["ignore", "pipe", "inherit"],
    })

    const ready = await waitForLine(child!.stdout!, (e) => e.type === "ready")
    expect(typeof ready.pid).toBe("number")
    expect(ready.socketPath).toContain(socketDir)

    // Confirm the registration is real, on disk, tagged as ours.
    const registryPath = join(claudeConfigDir, "sessions", `${ready.pid}.json`)
    const registration = JSON.parse(await readFile(registryPath, "utf8"))
    expect(registration.managedBy).toBe("opencode-skein")
    expect(registration.ownerSessionID).toBe("ses_test_owner")
    expect(registration.peerProtocol).toBe(1)

    const hash = keyFileHash(ready.socketPath)
    const keyFile = JSON.parse(await readFile(join(claudeConfigDir, "sessions", `${ready.pid}.${hash}.key`), "utf8"))
    expect(typeof keyFile.peerToken).toBe("string")

    // Act as a real Claude peer would: connect, auth, send the message frame.
    const inboundPromise = waitForLine(child!.stdout!, (e) => e.type === "inbound")
    await new Promise<void>((resolve, reject) => {
      const socket = connect(ready.socketPath)
      socket.once("connect", () => {
        const frames = [
          { type: "auth", token: keyFile.peerToken },
          {
            msgV: 1,
            msg_id: "test-msg-1",
            type: "user",
            message: {
              role: "user",
              content:
                '<cross-session-message from="uds:/tmp/cc-socks/999.sock" from-name="real-claude-peer" from-mode="idle">\nendpoint POST /x merged\n</cross-session-message>',
            },
            priority: "next",
            from: "uds:/tmp/cc-socks/999.sock",
          },
        ]
        socket.write(frames.map((f) => JSON.stringify(f)).join("\n") + "\n", () => {
          socket.end()
        })
      })
      socket.once("close", () => resolve())
      socket.once("error", reject)
    })

    const inbound = await inboundPromise
    expect(inbound.text).toBe("endpoint POST /x merged")
    expect(inbound.fromName).toBe("real-claude-peer")

    // Shut it down and confirm it cleaned up its own registration.
    child!.kill("SIGTERM")
    await new Promise<void>((resolve) => child!.once("exit", () => resolve()))
    const remaining = await readdir(join(claudeConfigDir, "sessions"))
    expect(remaining).toEqual([])
  }, 20_000)

  test("strips the correlation header from inbound text so delegate.ts still matches", async () => {
    child = spawn("bun", ["run", ENTRY], {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        OPENCODE_SIDECAR_OWNER_SESSION_ID: "ses_test_owner_3",
        OPENCODE_SIDECAR_CWD: "/repo",
        OPENCODE_SIDECAR_NAME: "opencode-e2e-test-3",
        OPENCODE_SIDECAR_SOCKET_DIR: socketDir,
      },
      stdio: ["ignore", "pipe", "inherit"],
    })

    const ready = await waitForLine(child!.stdout!, (e) => e.type === "ready")

    const hash = keyFileHash(ready.socketPath)
    const keyFile = JSON.parse(await readFile(join(claudeConfigDir, "sessions", `${ready.pid}.${hash}.key`), "utf8"))

    // Send a message with an envelope header followed by the older task-result
    // marker. The sidecar must strip the header so the marker is still at the
    // start of the body, and delegate.ts can match it.
    const wrapped = formatPeerEnvelope(
      { mode: "reply", messageID: "m1", taskID: "ses_child" },
      "[peer-task-result ses_child]\nthe delegated work is done",
    )
    const inboundPromise = waitForLine(child!.stdout!, (e) => e.type === "inbound")
    await new Promise<void>((resolve, reject) => {
      const socket = connect(ready.socketPath)
      socket.once("connect", () => {
        const frames = [
          { type: "auth", token: keyFile.peerToken },
          {
            msgV: 1,
            msg_id: "test-msg-2",
            type: "user",
            message: { role: "user", content: wrapped },
            priority: "next",
            from: "uds:/tmp/cc-socks/999.sock",
          },
        ]
        socket.write(frames.map((f) => JSON.stringify(f)).join("\n") + "\n", () => socket.end())
      })
      socket.once("close", () => resolve())
      socket.once("error", reject)
    })

    const inbound = await inboundPromise
    // The sidecar passes the raw text through; header stripping happens in
    // lifecycle.ts via peerBody() before settleTaskReply is called.
    expect(inbound.text).toBe(
      "[peer reply id=m1 task=ses_child]\n\n[peer-task-result ses_child]\nthe delegated work is done",
    )
  }, 20_000)

  test("refuses a connection with the wrong token", async () => {
    child = spawn("bun", ["run", ENTRY], {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        OPENCODE_SIDECAR_OWNER_SESSION_ID: "ses_test_owner_2",
        OPENCODE_SIDECAR_CWD: "/repo",
        OPENCODE_SIDECAR_NAME: "opencode-e2e-test-2",
        OPENCODE_SIDECAR_SOCKET_DIR: socketDir,
      },
      stdio: ["ignore", "pipe", "inherit"],
    })

    const ready = await waitForLine(child!.stdout!, (e) => e.type === "ready")

    const closedWithoutInbound = await new Promise<boolean>((resolve, reject) => {
      const socket = connect(ready.socketPath)
      let gotInbound = false
      const inboundGuard = setTimeout(() => resolve(!gotInbound), 500)
      child!.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString("utf8").includes('"type":"inbound"')) gotInbound = true
      })
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ type: "auth", token: "wrong-token" })}\n`)
      })
      socket.once("close", () => {
        clearTimeout(inboundGuard)
        resolve(!gotInbound)
      })
      socket.once("error", reject)
    })

    expect(closedWithoutInbound).toBe(true)
  }, 20_000)

  test("self-terminates and cleans up its own registration when its parent dies without signalling it", async () => {
    // Spawns an intermediary process that itself spawns the real sidecar as
    // ITS child, then exits immediately — orphaning the sidecar exactly the
    // way a crashed/SIGKILLed opencode server would (Process.spawn children
    // don't die with their parent). This is the case a next-boot orphan
    // sweep can NOT reclaim, because the orphaned sidecar's pid stays alive.
    const fakeParent = join(await mkdtemp(join(tmpdir(), "sidecar-fake-parent-")), "spawn-and-exit.ts")
    const readyPath = join(tmpdir(), `sidecar-orphan-ready-${Date.now()}.json`)
    await Bun.write(
      fakeParent,
      `
      import { spawn } from "child_process"
      import { writeFileSync } from "fs"
      const child = spawn("bun", ["run", ${JSON.stringify(ENTRY)}], {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "ignore"],
      })
      child.stdout.on("data", (chunk) => {
        const line = chunk.toString("utf8").split("\\n").find((l) => l.includes('"type":"ready"'))
        if (line) writeFileSync(${JSON.stringify(readyPath)}, line)
      })
      // Give it a moment to register before this process vanishes.
      setTimeout(() => process.exit(0), 1500)
      `,
    )

    const fakeParentProc = spawn("bun", ["run", fakeParent], {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        OPENCODE_SIDECAR_OWNER_SESSION_ID: "ses_orphan_test",
        OPENCODE_SIDECAR_CWD: "/repo",
        OPENCODE_SIDECAR_NAME: "opencode-orphan-test",
        OPENCODE_SIDECAR_SOCKET_DIR: socketDir,
      },
      stdio: "ignore",
    })
    await new Promise<void>((resolve) => fakeParentProc.once("exit", () => resolve()))

    let ready: { pid: number } | undefined
    for (let i = 0; i < 40 && !ready; i++) {
      try {
        ready = JSON.parse(await Bun.file(readyPath).text())
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    expect(ready).toBeDefined()
    const sidecarPid = ready!.pid

    // Orphaned now — the sidecar's own orphan-detection loop (polls every
    // 2s) should notice its ppid changed and self-clean well within this
    // window, without anything here signalling it directly.
    let stillRegistered = true
    for (let i = 0; i < 60 && stillRegistered; i++) {
      const entries = await readdir(join(claudeConfigDir, "sessions")).catch(() => [])
      stillRegistered = entries.some((e) => e === `${sidecarPid}.json`)
      if (stillRegistered) await new Promise((r) => setTimeout(r, 100))
    }
    expect(stillRegistered).toBe(false)

    await rm(readyPath, { force: true })
  }, 20_000)
})
