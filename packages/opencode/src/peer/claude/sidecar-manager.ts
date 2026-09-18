// Parent-side owner of the per-session sidecar processes (see
// sidecar-entry.ts for the child). Spawns one per top-level session, reads
// its NDJSON stdout, and hands inbound messages to the injected `deliver`.
import path from "path"
import { fileURLToPath } from "url"
import { Process } from "@/util/process"
import { which } from "@/util/which"
import { sweepStaleSidecars } from "./sidecar-registry"

// A compiled single-file binary doesn't ship sidecar-entry.ts as a real file
// on disk, so `bun run <path-to-sidecar-entry.ts>` only works when running
// from source. The `debug claude-sidecar-entry` subcommand is the path that
// works in both cases; when running from source under bun, run the source
// index so the same subcommand resolves against the checkout.
const SRC_INDEX_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "index.ts")

function sidecarCommand(): string[] {
  const isBunRuntime = path.basename(process.execPath).startsWith("bun")
  if (isBunRuntime) return [process.execPath, "run", SRC_INDEX_PATH, "debug", "claude-sidecar-entry"]
  return [process.execPath, "debug", "claude-sidecar-entry"]
}

export interface SidecarInfo {
  sessionID: string
  pid?: number
  socketPath?: string
}

interface Managed extends SidecarInfo {
  name: string
  child: ReturnType<typeof Process.spawn>
}

const active = new Map<string, Managed>()

/** The name Claude Code peers see this session under (`ListAgents`), once its sidecar is up. */
export function sidecarNameFor(sessionID: string): string | undefined {
  const managed = active.get(sessionID)
  if (!managed?.pid) return undefined
  return `opencode:${managed.name}`
}

/**
 * The socket a peer connects to in order to reach this session — its real
 * return address. Undefined until the sidecar has reported `ready`, or when
 * the session has no sidecar (a subagent, or messaging disabled).
 */
export function sidecarSocketPathFor(sessionID: string): string | undefined {
  return active.get(sessionID)?.socketPath
}

/** No point registering a peer nothing on this machine can discover. */
export function claudeCodePresent(): boolean {
  return which("claude") !== null
}

export function isManaged(sessionID: string): boolean {
  return active.has(sessionID)
}

export function activeSidecars(): SidecarInfo[] {
  return [...active.values()].map(({ sessionID, pid, socketPath }) => ({ sessionID, pid, socketPath }))
}

export interface EnsureSidecarInput {
  sessionID: string
  cwd: string
  name: string
}

/** One inbound peer message, as the sidecar reported it. */
export interface InboundDelivery {
  /** The owner session this sidecar speaks for. */
  sessionID: string
  text: string
  /** Envelope attributes — display only, never authorization (see codec.ts). */
  fromName?: string
  /** The sender's return address (`uds:<socket>`), when the envelope carried one. */
  from?: string
  /** The frame's `msg_id` — a real correlation id, used to drop duplicate deliveries. */
  msgID?: string
  priority?: string
}

export type Deliver = (inbound: InboundDelivery) => void

export interface SidecarHooks {
  /**
   * Receives one line per sidecar stderr line and one line on an abnormal
   * exit. The TUI owns the terminal streams while it runs, so the manager
   * never writes these anywhere itself — the caller routes them to the
   * application logger. Without a hook they are drained and dropped.
   */
  diagnostic?: (message: string) => void
}

const MAX_DIAGNOSTIC_LINE = 2_000

/**
 * Spawns a sidecar for this session if one isn't already running. The
 * sidecar is the session's address for every other agent process on this
 * machine — opencode siblings as much as Claude Code — so it runs whether or
 * not Claude Code is installed.
 */
export function ensureSidecar(input: EnsureSidecarInput, deliver: Deliver, hooks: SidecarHooks = {}): void {
  if (active.has(input.sessionID)) return

  const child = Process.spawn(sidecarCommand(), {
    env: {
      OPENCODE_SIDECAR_OWNER_SESSION_ID: input.sessionID,
      OPENCODE_SIDECAR_CWD: input.cwd,
      OPENCODE_SIDECAR_NAME: input.name,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  const managed: Managed = { sessionID: input.sessionID, name: input.name, child }
  active.set(input.sessionID, managed)

  const diagnostic = hooks.diagnostic
  if (diagnostic) {
    let errBuffer = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      errBuffer += chunk.toString("utf8")
      let newlineIndex: number
      while ((newlineIndex = errBuffer.indexOf("\n")) >= 0) {
        const line = errBuffer.slice(0, newlineIndex).trimEnd()
        errBuffer = errBuffer.slice(newlineIndex + 1)
        if (line) diagnostic(line.slice(0, MAX_DIAGNOSTIC_LINE))
      }
    })
  } else {
    child.stderr?.resume()
  }

  let buffer = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      if (!line.trim()) continue

      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof event !== "object" || event === null) continue
      const e = event as Record<string, unknown>

      if (e.type === "ready") {
        if (typeof e.pid === "number") managed.pid = e.pid
        if (typeof e.socketPath === "string") managed.socketPath = e.socketPath
      } else if (e.type === "inbound" && typeof e.text === "string") {
        deliver({
          sessionID: input.sessionID,
          text: e.text,
          fromName: typeof e.fromName === "string" ? e.fromName : undefined,
          from: typeof e.from === "string" ? e.from : undefined,
          msgID: typeof e.msgID === "string" ? e.msgID : undefined,
          priority: typeof e.priority === "string" ? e.priority : undefined,
        })
      }
    }
  })

  child.once("exit", (code, signal) => {
    if (active.get(input.sessionID) === managed) active.delete(input.sessionID)
    if (code !== 0 && code !== null) {
      diagnostic?.(`sidecar exited with code ${code}${signal ? ` (${signal})` : ""}`)
    }
  })
}

function control(sessionID: string, message: Record<string, unknown>): void {
  const managed = active.get(sessionID)
  const stdin = managed?.child.stdin as { write?: (chunk: string) => unknown } | null | undefined
  if (!stdin?.write) return
  try {
    stdin.write(`${JSON.stringify(message)}\n`)
  } catch {
    // sidecar gone; the exit handler cleans up
  }
}

/** Mirror a session's status into its registry entry; a no-op for sessions without a sidecar. */
export function setSidecarStatus(sessionID: string, status: "idle" | "busy"): void {
  control(sessionID, { type: "status", status })
}

/**
 * Mirror a session's title into its registry entry. Sessions are registered
 * at creation, when the title is still a placeholder, so without this every
 * peer sees the placeholder for the life of the session.
 */
export function setSidecarName(sessionID: string, name: string): void {
  const managed = active.get(sessionID)
  if (!managed || managed.name === name) return
  managed.name = name
  control(sessionID, { type: "name", name })
}

export async function stopSidecar(sessionID: string): Promise<void> {
  const managed = active.get(sessionID)
  if (!managed) return
  active.delete(sessionID)
  await Process.stop(managed.child)
}

export async function stopAllSidecars(): Promise<void> {
  await Promise.all([...active.keys()].map((sessionID) => stopSidecar(sessionID)))
}

/** Recovery path for a sidecar killed before it could clean up after itself — see sidecar-registry.ts. Safe to call on every server startup. */
export async function sweepOrphanedSidecars(): Promise<string[]> {
  return sweepStaleSidecars((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })
}

export * as SidecarManager from "./sidecar-manager"
