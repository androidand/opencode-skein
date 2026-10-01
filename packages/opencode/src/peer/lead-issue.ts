// The user-side half of the lead grant: figuring out which session the user is
// sitting in, and writing the grant for it.
//
// The caller is identified by walking the process ancestry from the command that
// is running to the first process that is a registered session — a Claude Code
// session (its own registry entry) or an opencode-skein sidecar (a managed
// registration). This is deliberately not an argument: "make session X the lead"
// typed by a model about someone else would be the self-grant this whole design
// exists to prevent, and ancestry cannot name a session the command is not
// running inside.
//
// The limit, stated plainly: a shell command run by a model inside that session
// has the same ancestry as one the user typed with the `!` prefix, so this file
// cannot tell them apart. The second layer is outside it — model shells deny
// `lead set` by permission, the grant is short-lived and listed by `peers`, and
// `lead off` is one command.
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { randomUUID } from "crypto"
import { LEAD_SCOPES, MAX_GRANT_LIFETIME_MS, type LeadGrant, type LeadScope } from "./lead"

export const DEFAULT_GRANT_TTL_MS = 8 * 60 * 60 * 1000

export interface SessionCandidate {
  harness: "opencode-skein" | "claude-code"
  pid: number
  sessionID?: string
  address?: string
  name?: string
}

/** Nearest ancestor (starting at the process itself) that is a known session. */
export function identifyCaller(ancestors: readonly number[], sessions: readonly SessionCandidate[]): SessionCandidate | undefined {
  for (const pid of ancestors) {
    const hit = sessions.find((session) => session.pid === pid)
    if (hit) return hit
  }
  return undefined
}

export function parseScopes(input: string | undefined): LeadScope[] | { error: string } {
  if (!input) return ["assign", "sync", "reprioritise", "decide"]
  const scopes: LeadScope[] = []
  for (const raw of input.split(",").map((part) => part.trim()).filter(Boolean)) {
    if (!(LEAD_SCOPES as readonly string[]).includes(raw)) return { error: `unknown scope: ${raw}` }
    scopes.push(raw as LeadScope)
  }
  return scopes.length > 0 ? scopes : { error: "no scopes given" }
}

export function parseTtl(input: string | undefined): number | { error: string } {
  if (!input) return DEFAULT_GRANT_TTL_MS
  const match = input.match(/^(\d+)(m|h)$/)
  if (!match) return { error: "ttl must look like 30m or 8h" }
  const ms = Number(match[1]) * (match[2] === "h" ? 3_600_000 : 60_000)
  if (ms <= 0) return { error: "ttl must be positive" }
  if (ms > MAX_GRANT_LIFETIME_MS) return { error: "ttl may not exceed 24h" }
  return ms
}

export function buildGrant(input: {
  lead: SessionCandidate
  scopes: LeadScope[]
  ttlMs: number
  now: number
  issuedBy: LeadGrant["issuedBy"]
}): LeadGrant {
  return {
    version: 1,
    id: `lead-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    lead: {
      harness: input.lead.harness,
      pid: input.lead.pid,
      ...(input.lead.sessionID ? { sessionID: input.lead.sessionID } : {}),
      ...(input.lead.address ? { address: input.lead.address } : {}),
      ...(input.lead.name ? { name: input.lead.name.replace(/[^\x20-\x7e]/g, "").slice(0, 80) } : {}),
    },
    scopes: input.scopes,
    delegates: [],
    issuedAt: input.now,
    expiresAt: input.now + input.ttlMs,
    issuedBy: input.issuedBy,
  }
}

/** Owner-only, written atomically so a reader never sees half a grant. */
export function writeGrantFile(path: string, grant: LeadGrant): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(path), `.lead-${process.pid}-${randomUUID()}.tmp`)
  writeFileSync(tmp, JSON.stringify(grant, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

export function removeGrantFile(path: string): boolean {
  try {
    rmSync(path)
    return true
  } catch {
    return false
  }
}

export * as PeerLeadIssue from "./lead-issue"
