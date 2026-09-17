// Runs INSIDE a genuinely separate process (see sidecar-entry.ts) — Claude's
// own identity model is confirmed one-process-per-session
// (claude-peer-protocol-spike/findings.md), so this cannot run as part of
// the main opencode server, which hosts many sessions in one process. This
// module registers that process as a Claude-compatible peer, tagged
// `managedBy: "opencode-skein"` (see sidecar-registry.ts) so it can always be
// told apart from a real Claude Code session and safely cleaned up.
import { randomBytes, randomUUID } from "crypto"
import { chmod, mkdir } from "fs/promises"
import { createServer, type Server, type Socket } from "net"
import { Process } from "@/util/process"
import { parseEnvelope } from "./codec"
import { MANAGED_BY, removeSidecarRegistration, writeSidecarRegistration, type SidecarRegistration } from "./sidecar-registry"

export interface InboundMessage {
  text: string
  from?: string
  fromName?: string
  priority?: string
}

export interface StartSidecarInput {
  /** The real opencode-skein session this sidecar speaks for. */
  ownerSessionID: string
  cwd: string
  name: string
  /** Directory the socket is created under — deliberately not Claude's own `/tmp/cc-socks`, to keep the two namespaces visually distinct for anyone debugging. */
  socketDir: string
  onMessage: (message: InboundMessage) => void
}

export interface RunningSidecar {
  pid: number
  socketPath: string
  peerProtocol: 1
  stop: () => Promise<void>
}

async function ownProcStart(pid: number): Promise<string> {
  const out = await Process.text(["ps", "-o", "lstart=", "-p", String(pid)], {
    env: { TZ: "UTC", LC_ALL: "C" },
    nothrow: true,
  })
  return out.text.trim()
}

function isAuthFrame(value: unknown): value is { type: "auth"; token: string } {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>).type === "auth"
}

function isMessageFrame(value: unknown): value is { message?: { content?: unknown }; priority?: unknown } {
  return typeof value === "object" && value !== null
}

function handleConnection(socket: Socket, peerToken: string, onMessage: (m: InboundMessage) => void): void {
  let buffer = ""
  let authed = false

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      if (!line.trim()) continue

      let frame: unknown
      try {
        frame = JSON.parse(line)
      } catch {
        socket.destroy()
        return
      }

      if (!authed) {
        if (isAuthFrame(frame) && frame.token === peerToken) {
          authed = true
          continue
        }
        // Wrong or missing token — refuse the connection outright, never a
        // partial/best-effort accept.
        socket.destroy()
        return
      }

      if (isMessageFrame(frame)) {
        const content = frame.message?.content
        if (typeof content === "string") {
          const parsed = parseEnvelope(content)
          onMessage({
            text: parsed.text,
            from: parsed.from,
            fromName: parsed.fromName,
            priority: typeof frame.priority === "string" ? frame.priority : undefined,
          })
        }
      }
    }
  })
}

export async function startSidecar(input: StartSidecarInput): Promise<RunningSidecar> {
  const pid = process.pid
  const socketPath = `${input.socketDir}/${pid}.sock`
  const peerToken = randomBytes(16).toString("hex")

  await mkdir(input.socketDir, { recursive: true, mode: 0o700 })

  const server: Server = createServer((socket) => handleConnection(socket, peerToken, input.onMessage))

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve())
  })
  await chmod(socketPath, 0o600)

  const procStart = await ownProcStart(pid)
  const registration: SidecarRegistration = {
    pid,
    // A Claude-shaped placeholder id, distinct from opencode's own session
    // id — `ownerSessionID` on the registration is the real cross-reference.
    sessionId: randomUUID(),
    cwd: input.cwd,
    startedAt: Date.now(),
    procStart,
    peerProtocol: 1,
    messagingSocketPath: socketPath,
    // Visibly marked even to a human running the raw `claude agents --json`
    // — Claude's own CLI drops `managedBy` (unknown field), so this prefix
    // is the only marker that survives to that output.
    name: `opencode:${input.name}`,
    status: "idle",
    managedBy: MANAGED_BY,
    ownerSessionID: input.ownerSessionID,
  }
  await writeSidecarRegistration(registration, peerToken)

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await removeSidecarRegistration(pid, socketPath)
  }

  return { pid, socketPath, peerProtocol: 1, stop }
}

export * as SidecarServer from "./sidecar-server"
