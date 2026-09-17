// Every registry file opencode-skein ever writes into
// `~/.claude/sessions/` — Claude Code's own state directory — carries an
// extra field Claude's real client tolerates as unknown-but-ignorable (the
// spike confirmed unknown fields are accepted): `managedBy: "opencode-skein"`.
//
// That marker is the entire safety contract for this module:
//   - it is the ONLY thing that makes a file "ours" — nothing here ever
//     writes, deletes, or overwrites a file lacking it
//   - a stale sweep (`sweepStaleSidecars`) only ever removes an entry that
//     both carries the marker AND whose pid is confirmed not running —
//     never a live session, never a real Claude session, marked or not
//   - opencode-skein owns cleanup for what it creates. Claude Code has no
//     idea these aren't its own sessions, and isn't expected to clean up
//     after them — that would require it to understand a marker it has no
//     reason to look for.
import { mkdir, readdir, readFile, unlink, writeFile } from "fs/promises"
import { keyFileHash, sessionsDir } from "./registry"

export const MANAGED_BY = "opencode-skein" as const

export interface SidecarRegistration {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  procStart: string
  peerProtocol: 1
  messagingSocketPath: string
  name: string
  status: "idle" | "busy"
  managedBy: typeof MANAGED_BY
  /** The real opencode-skein session this sidecar speaks for — for cross-reference and diagnostics, never load-bearing for cleanup safety (the pid liveness check is). */
  ownerSessionID: string
}

function isManagedEntry(value: unknown): value is { pid: number; managedBy: string; messagingSocketPath?: string } {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.pid === "number" && v.managedBy === MANAGED_BY
}

export async function writeSidecarRegistration(registration: SidecarRegistration, peerToken: string): Promise<void> {
  const dir = sessionsDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(`${dir}/${registration.pid}.json`, JSON.stringify(registration), { mode: 0o644 })
  const hash = keyFileHash(registration.messagingSocketPath)
  await writeFile(
    `${dir}/${registration.pid}.${hash}.key`,
    JSON.stringify({ peerToken, procStart: registration.procStart, pidDomain: process.platform }),
    { mode: 0o600 },
  )
}

/** Removes exactly this sidecar's own two files. Called on its own clean shutdown. */
export async function removeSidecarRegistration(pid: number, messagingSocketPath: string): Promise<void> {
  const dir = sessionsDir()
  const hash = keyFileHash(messagingSocketPath)
  await Promise.allSettled([unlink(`${dir}/${pid}.json`), unlink(`${dir}/${pid}.${hash}.key`)])
}

/**
 * Removes marker-tagged registrations whose process is no longer running —
 * the recovery path for a sidecar that was killed (crash, SIGKILL, machine
 * restart) before it could clean up after itself. Anything without the
 * marker is left completely untouched, whether it looks stale or not: it
 * might be a real Claude Code session this process has no business judging.
 */
export async function sweepStaleSidecars(isAlive: (pid: number) => boolean): Promise<string[]> {
  const dir = sessionsDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(`${dir}/${entry}`, "utf8"))
    } catch {
      continue
    }
    if (!isManagedEntry(parsed)) continue
    if (isAlive(parsed.pid)) continue

    if (typeof parsed.messagingSocketPath === "string") {
      await removeSidecarRegistration(parsed.pid, parsed.messagingSocketPath)
    } else {
      await unlink(`${dir}/${entry}`).catch(() => undefined)
    }
    removed.push(entry)
  }
  return removed
}

/**
 * Every pid this opencode-skein instance has registered as a sidecar, read
 * straight from the raw registry files — never from `claude agents --json`,
 * which only projects Claude's own known fields and silently drops
 * `managedBy`. This is how a Claude presence source excludes "sessions" that
 * are actually opencode in disguise, regardless of which path supplied the
 * record it's filtering.
 */
export async function listManagedPids(): Promise<Set<number>> {
  const dir = sessionsDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return new Set()
  }

  const pids = new Set<number>()
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue
    try {
      const parsed: unknown = JSON.parse(await readFile(`${dir}/${entry}`, "utf8"))
      if (isManagedEntry(parsed)) pids.add(parsed.pid)
    } catch {
      // Malformed file — not ours to judge here either.
    }
  }
  return pids
}

export * as SidecarRegistry from "./sidecar-registry"
