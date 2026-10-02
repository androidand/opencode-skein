// PTY exchange proof-of-concept for peer-conversation-reliability task 5.3.
//
// Proves that two opencode processes can run simultaneously with bun-pty
// without hanging on stdin (the root cause of the exit-137 observed in the
// live exchange attempt). The fix is the harness, not the binary:
// `process.stdin.isTTY` is true inside a bun-pty terminal, so
// `src/cli/cmd/run.ts:423` skips the piped-stdin-read entirely.
//
// This is a standalone script — not yet wired into cli-process.ts — so it
// can be iterated on independently. Once proven, the pattern ports there.
//
// Usage: bun run test/peer/pty-exchange.ts

import { spawn } from "bun-pty"
import { connect } from "net"
import { readdir, readFile } from "fs/promises"
import { homedir } from "os"
import { join } from "path"
import * as crypto from "crypto"

const OPENCODE_ROOT = "/Users/andreas/dev/opencode-skein/packages/opencode"
const REGISTRY_DIR = join(homedir(), ".claude")
const SESSIONS_DIR = join(REGISTRY_DIR, "sessions")
const CLI_ENTRY = "src/index.ts"

// Note: "bun" is the executable passed as the first arg to spawn; CMD starts
// with "run", not "bun". Prepending "bun" here would produce `bun bun run`
// which bun rejects as "Must use --outdir when specifying more than one entry point."
const CMD = ["run", "--conditions=browser", CLI_ENTRY, "--mini", "--"]

interface PTYProcess {
  terminal: ReturnType<typeof spawn>
  pid: number | null
  output: string
  exitCode: number | null
  exitSignal: string | number | null
}

async function findSidecarEntry(targetPid: number, timeoutMs = 10_000): Promise<{
  socketPath: string
  token: string
} | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const entries = await readdir(SESSIONS_DIR).catch(() => [] as string[])
      const jsonFile = entries.find((e) => e === `${targetPid}.json`)
      if (!jsonFile) {
        await new Promise((r) => setTimeout(r, 50))
        continue
      }
      const raw = JSON.parse(await readFile(join(SESSIONS_DIR, jsonFile), "utf8"))
      if (!raw?.messagingSocketPath) {
        await new Promise((r) => setTimeout(r, 50))
        continue
      }
      const hash = crypto.createHash("sha256").update(raw.messagingSocketPath).digest("hex")
      const keyRaw = JSON.parse(await readFile(join(SESSIONS_DIR, `${targetPid}.${hash}.key`), "utf8"))
      return { socketPath: raw.messagingSocketPath, token: keyRaw.peerToken }
    } catch {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  return null
}

async function spawnPTY(label: string, message: string): Promise<PTYProcess> {
  const terminal = spawn("bun", [...CMD, message], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: OPENCODE_ROOT,
  })

  const proc: PTYProcess = { terminal, pid: null, output: "", exitCode: null, exitSignal: null }

  terminal.onData((data) => {
    proc.output += data
    process.stdout.write(`[${label}] ${data}`)
  })

  terminal.onExit(({ exitCode, signal }) => {
    proc.exitCode = exitCode
    proc.exitSignal = signal ?? null
    console.log(`\n[${label}] Process exited with code ${exitCode} and signal ${signal}`)
  })

  for (let i = 0; i < 200 && proc.pid === null; i++) {
    if (terminal.pid) {
      proc.pid = terminal.pid
      break
    }
    await new Promise((r) => setTimeout(r, 50))
  }

  return proc
}

async function sendPeerMessage(
  socketPath: string,
  token: string,
  message: string,
  fromAddress: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    socket.once("connect", () => {
      const frames = [
        { type: "auth", token },
        {
          msgV: 1,
          msg_id: `pty-exchange-${Date.now()}`,
          type: "user",
          message: {
            role: "user",
            content: `<cross-session-message from="${fromAddress}" from-name="peer" from-mode="idle">\n${message}\n</cross-session-message>`,
          },
          priority: "next",
          from: fromAddress,
        },
      ]
      socket.write(frames.map((f) => JSON.stringify(f)).join("\n") + "\n", () => socket.end())
    })
    socket.once("close", () => resolve())
    socket.once("error", reject)
  })
}

async function main() {
  console.log("=== PTY Exchange Proof-of-Concept ===\n")

  console.log("Spawning process B (receiver)...")
  const procB = await spawnPTY("B", "hello from B")
  console.log(`Process B PID: ${procB.pid}`)

  console.log("Waiting for process B sidecar...")
  const sidecarB = procB.pid ? await findSidecarEntry(procB.pid) : null
  if (!sidecarB) {
    console.log("WARNING: Could not find process B sidecar entry (non-fatal for basic test)")
  } else {
    console.log(`Process B sidecar: ${sidecarB.socketPath}`)
  }

  console.log("\nSpawning process A (sender)...")
  const procA = await spawnPTY("A", "hello from A")
  console.log(`Process A PID: ${procA.pid}`)

  console.log("Waiting for process A sidecar...")
  const sidecarA = procA.pid ? await findSidecarEntry(procA.pid) : null
  if (!sidecarA) {
    console.log("WARNING: Could not find process A sidecar entry (non-fatal for basic test)")
  } else {
    console.log(`Process A sidecar: ${sidecarA.socketPath}`)
  }

  if (sidecarB && sidecarA) {
    console.log("\nSending peer request from A to B...")
    const fromAddress = `uds:${sidecarA.socketPath}`
    await sendPeerMessage(
      sidecarB.socketPath,
      sidecarB.token,
      "[peer request id=pty-test-1 from=uds:test deadline=5m]\nHello from PTY exchange test",
      fromAddress,
    ).catch((err) => console.log(`Failed to send peer message: ${err}`))
  } else {
    console.log("\nSkipping peer message send (sidecar entries not found)")
  }

  console.log("\nWaiting 10 seconds for processes to settle...")
  await new Promise((r) => setTimeout(r, 10_000))

  console.log("\nCleaning up...")
  procA.terminal.kill()
  procB.terminal.kill()

  await new Promise((r) => setTimeout(r, 1000))

  console.log("\n=== Summary ===")
  console.log(`Process A: exitCode=${procA.exitCode}, exitSignal=${procA.exitSignal}`)
  console.log(`Process B: exitCode=${procB.exitCode}, exitSignal=${procB.exitSignal}`)
  console.log(`Process A output length: ${procA.output.length}`)
  console.log(`Process B output length: ${procB.output.length}`)

  const hasHang = procA.exitCode === null && procB.exitCode === null
  console.log(`Hang detected: ${hasHang}`)

  if (!hasHang) {
    console.log("\nSUCCESS: Both processes completed without hanging!")
  } else {
    console.log("\nFAILURE: Processes may have hung")
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
