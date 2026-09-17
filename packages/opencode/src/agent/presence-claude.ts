// Claude Code as a presence source: reads Claude's own local session registry
// and projects it into the same `AgentPresence.Info` shape opencode-skein's
// own sessions already publish. Read-only — see
// openspec/changes/claude-code-peer-source. Never reads a `*.key` file: those
// hold peer auth tokens and belong to `peer/claude` (outbound messaging), not
// to presence.
//
// Schema and permission model verified against a real, live Claude Code
// install — see openspec/changes/claude-peer-protocol-spike/findings.md.
import { homedir } from "os"
import { join } from "path"
import { readdir, readFile } from "fs/promises"
import * as AgentPresence from "./presence"
import { Process } from "@/util/process"
import { which } from "@/util/which"
import { listManagedPids } from "@/peer/claude/sidecar-registry"

export interface ClaudeAgentRecord {
  pid: number
  cwd: string
  sessionId: string
  startedAt: number
  name?: string
  status?: string
  statusUpdatedAt?: number
}

export function isClaudeAgentRecord(value: unknown): value is ClaudeAgentRecord {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.pid === "number" &&
    typeof v.cwd === "string" &&
    typeof v.sessionId === "string" &&
    typeof v.startedAt === "number"
  )
}

export interface ResolveInput {
  /** Raw parsed JSON entries, from `claude agents --json` or the registry fallback. Unknown shapes are dropped, never thrown on. */
  records: readonly unknown[]
  now: number
  /** Injectable for tests; real liveness is `process.kill(pid, 0)` not throwing. */
  isAlive: (pid: number) => boolean
  /** Whether this instance can message Claude Code peers (`peer/claude`). */
  messaging?: boolean
}

/**
 * Pure projection from raw Claude registry entries to `AgentPresence.Info`.
 * Fields Claude does not publish stay absent — never fabricated. Control
 * capabilities are always `false` here: this source is read-only by design,
 * a separate outbound channel (`peer/claude`) is what makes a peer reachable.
 */
export function resolveClaudePeers(input: ResolveInput): AgentPresence.Info[] {
  const peers: AgentPresence.Info[] = []
  for (const raw of input.records) {
    if (!isClaudeAgentRecord(raw)) continue
    const alive = input.isAlive(raw.pid)
    const status: AgentPresence.Status = !alive ? "unreachable" : raw.status === "idle" ? "idle" : "busy"
    peers.push({
      owner: "claude-code",
      instanceID: String(raw.pid),
      sessionID: raw.sessionId,
      directory: raw.cwd,
      status,
      lastEventAt: raw.statusUpdatedAt ?? raw.startedAt,
      heartbeatAt: input.now,
      canPrompt: alive && input.messaging === true,
      canBtw: false,
      canAbort: false,
    })
  }
  return peers
}

function registryDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
}

async function fetchViaCli(): Promise<unknown[] | undefined> {
  if (!which("claude")) return undefined
  try {
    const out = await Process.text(["claude", "agents", "--json"], { nothrow: true })
    if (out.code !== 0) return undefined
    const parsed = JSON.parse(out.text)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Fallback when the `claude` binary is unavailable. Reads only `<pid>.json`
 * registry files — a `*.key` file (peer auth token) is never opened here.
 */
async function fetchViaRegistry(): Promise<unknown[]> {
  const dir = join(registryDir(), "sessions")
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const records: unknown[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue
    try {
      records.push(JSON.parse(await readFile(join(dir, entry), "utf8")))
    } catch {
      // One malformed file must not fail the whole roster.
    }
  }
  return records
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const POLL_CACHE_MS = 2_000
let cache: { at: number; records: ClaudeAgentRecord[] } | undefined

/**
 * Polled, cached read of Claude Code's live session registry, validated but
 * otherwise raw — this is what both the presence projection and target
 * resolution (matching by pid or display name) share, so a burst of either
 * kind of call within the cache window spawns at most one `claude` process.
 * A failure at any stage (binary missing, non-JSON output, unreadable
 * directory) yields zero records, never a thrown error.
 */
export async function fetchClaudeAgentRecords(opts: { enabled: boolean; now?: number }): Promise<ClaudeAgentRecord[]> {
  if (!opts.enabled) return []
  const now = opts.now ?? Date.now()
  if (cache && now - cache.at < POLL_CACHE_MS) return cache.records

  let raw: unknown[] | undefined
  try {
    raw = (await fetchViaCli()) ?? (await fetchViaRegistry())
  } catch {
    raw = []
  }

  // `claude agents --json` only projects Claude's own known fields and
  // silently drops any `managedBy` marker, so excluding our own sidecar
  // "sessions" (real Claude entries that are actually opencode in disguise —
  // see peer/claude/sidecar-registry.ts) has to cross-reference the raw
  // registry files directly, regardless of which path supplied `raw`.
  let managedPids: Set<number>
  try {
    managedPids = await listManagedPids()
  } catch {
    managedPids = new Set()
  }

  const records = (raw ?? []).filter(isClaudeAgentRecord).filter((record) => !managedPids.has(record.pid))
  cache = { at: now, records }
  return records
}

export async function listClaudePeers(opts: {
  enabled: boolean
  messaging?: boolean
  now?: number
}): Promise<AgentPresence.Info[]> {
  const now = opts.now ?? Date.now()
  const records = await fetchClaudeAgentRecords({ enabled: opts.enabled, now })
  return resolveClaudePeers({ records, now, isAlive, messaging: opts.messaging })
}

export * as PresenceClaude from "./presence-claude"
