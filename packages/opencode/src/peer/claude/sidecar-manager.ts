// Runs in the main opencode server process. Spawns a real, separate sidecar
// process per opted-in session (see sidecar-entry.ts), reads its stdout for
// inbound messages, and forwards them to the real session via an injected
// `deliver` callback — the caller wires that to the same synthetic-prompt
// injection `send_peer_message` already uses (`session.prompt(...,
// synthetic: true)`), so this module never needs to know how that works.
import path from "path"
import { fileURLToPath } from "url"
import { Process } from "@/util/process"
import { which } from "@/util/which"
import { sweepStaleSidecars } from "./sidecar-registry"

// A compiled single-file binary doesn't ship sidecar-entry.ts as a real file
// on disk, so `bun run <path-to-sidecar-entry.ts>` only works when running
// from source — confirmed live (2026-09-17): the sidecar crashed on every
// real TUI launch because that file simply isn't there in `dist/`. The
// sidecar runs as a hidden subcommand of the same executable instead.
//
// In dev, that means `bun run <src/index.ts> debug claude-sidecar-entry` —
// resolved relative to this file's own location, NOT `Bun.main`, which
// reflects whatever actually launched the CURRENT process (the test runner,
// under `bun test`) rather than the app's real entry point.
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
  child: ReturnType<typeof Process.spawn>
}

const active = new Map<string, Managed>()

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

/**
 * Spawns a sidecar for this session if one isn't already running. A no-op
 * when Claude Code isn't installed on this machine, or one is already
 * active for this session id.
 */
export function ensureSidecar(
  input: EnsureSidecarInput,
  deliver: (sessionID: string, text: string, fromName?: string) => void,
): void {
  if (!claudeCodePresent()) return
  if (active.has(input.sessionID)) return

  const child = Process.spawn(sidecarCommand(), {
    env: {
      OPENCODE_SIDECAR_OWNER_SESSION_ID: input.sessionID,
      OPENCODE_SIDECAR_CWD: input.cwd,
      OPENCODE_SIDECAR_NAME: input.name,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const managed: Managed = { sessionID: input.sessionID, child }
  active.set(input.sessionID, managed)

  child.stderr?.on("data", (chunk: Buffer) => {
    console.error(`[claude-sidecar ${input.sessionID}]`, chunk.toString("utf8").trimEnd())
  })

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
        deliver(input.sessionID, e.text, typeof e.fromName === "string" ? e.fromName : undefined)
      }
    }
  })

  child.once("exit", (code, signal) => {
    if (active.get(input.sessionID) === managed) active.delete(input.sessionID)
    if (code !== 0 && code !== null) {
      console.error(`[claude-sidecar ${input.sessionID}] exited with code ${code}${signal ? ` (${signal})` : ""}`)
    }
  })
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
