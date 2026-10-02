// The lead grant: the one place "this session speaks for the user" is recorded.
//
// Peer text is context, never authority — that rule is correct and stays. What it
// leaves no room for is the user saying, once and durably, "this session is my
// lead for planning and ordering". This module is that record and its check.
//
// Two properties carry the whole design:
//
//   1. Authority originates in a file only the user's own action writes (the
//      CLI/TUI command, never a model-callable tool). Nothing here writes it.
//   2. Verification compares the AUTHENTICATED sender (the socket the message
//      arrived on, resolved to a session or pid by the caller) with the grant.
//      The message body and the envelope's self-asserted fields are never
//      inputs, which is why a forged or relayed "the lead says" cannot pass.
//
// The check that matters most is at parse time. A grant that still parses but has
// quietly stopped meaning anything — a scalar where a mapping belongs, an expired
// time, a dead process — must not keep working, so parsing is a closed schema and
// fails closed with a reason.
//
// Pure and import-light, in the shape of ./envelope and ./repeat-guard, so it can
// be tested without a runtime and reused by every delivery path.
import { readFileSync, statSync } from "fs"

export const LEAD_SCOPES = ["assign", "sync", "reprioritise", "decide"] as const
export type LeadScope = (typeof LEAD_SCOPES)[number]

export type LeadHarness = "opencode-skein" | "claude-code"

/**
 * A timed grant must not live forever. A grant with `expiresAt: null` lasts as long as the lead
 * SESSION does instead, and is only accepted together with the identity of the lead process
 * (`lead.procStart`), because "the same pid" stops meaning "the same session" once the OS reuses it.
 */
export const MAX_GRANT_LIFETIME_MS = 24 * 60 * 60 * 1000

// Ids are rendered into a frame the receiving model reads as trusted, so the
// charset is closed rather than escaped.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface LeadGrant {
  version: 1
  id: string
  lead: { harness: LeadHarness; sessionID?: string; pid: number; address?: string; name?: string; procStart?: string }
  scopes: LeadScope[]
  delegates: { kind: string; scopes: string[] }[]
  issuedAt: number
  /** null = until the lead session ends; then `lead.procStart` is required. */
  expiresAt: number | null
  issuedBy: "user:tui" | "user:cli"
}

export type GrantResult = { ok: true; grant: LeadGrant } | { ok: false; reason: string }

export interface ParseDeps {
  pidAlive: (pid: number) => boolean
  /**
   * The start time the OS reports for a pid, or undefined when it cannot be read. Compared with the
   * grant's `lead.procStart`: a different value means the pid was reused by another process.
   */
  startTime?: (pid: number) => string | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key))
}

const fail = (reason: string): GrantResult => ({ ok: false, reason })

/** Validates a decoded grant. Closed schema; every rejection names its cause. */
export function parseGrant(raw: unknown, now: number, deps: ParseDeps): GrantResult {
  if (!isRecord(raw)) return fail("grant is not a mapping")
  const extra = unknownKeys(raw, ["version", "id", "lead", "scopes", "delegates", "issuedAt", "expiresAt", "issuedBy"])
  if (extra.length > 0) return fail(`unknown key: ${extra.join(", ")}`)
  if (raw.version !== 1) return fail("unsupported version")
  if (typeof raw.id !== "string" || !SAFE_ID.test(raw.id)) return fail("id is missing or has unsafe characters")

  const lead = raw.lead
  if (!isRecord(lead)) return fail("lead is not a mapping")
  const leadExtra = unknownKeys(lead, ["harness", "sessionID", "pid", "address", "name", "procStart"])
  if (leadExtra.length > 0) return fail(`unknown key in lead: ${leadExtra.join(", ")}`)
  if (lead.harness !== "opencode-skein" && lead.harness !== "claude-code") return fail("lead.harness is invalid")
  if (typeof lead.pid !== "number" || !Number.isInteger(lead.pid) || lead.pid <= 0) return fail("lead.pid is invalid")
  for (const key of ["sessionID", "address", "name", "procStart"] as const) {
    if (lead[key] !== undefined && typeof lead[key] !== "string") return fail(`lead.${key} is not a string`)
  }
  if (lead.harness === "opencode-skein" && typeof lead.sessionID !== "string") {
    return fail("an opencode lead must name its sessionID")
  }

  if (!Array.isArray(raw.scopes) || raw.scopes.length === 0) return fail("scopes must be a non-empty list")
  const scopes: LeadScope[] = []
  for (const scope of raw.scopes) {
    if (!(LEAD_SCOPES as readonly unknown[]).includes(scope)) return fail(`unknown scope: ${String(scope)}`)
    scopes.push(scope as LeadScope)
  }

  const delegates: LeadGrant["delegates"] = []
  if (!Array.isArray(raw.delegates)) return fail("delegates must be a list")
  for (const entry of raw.delegates) {
    if (!isRecord(entry)) return fail("a delegate is not a mapping")
    const delegateExtra = unknownKeys(entry, ["kind", "scopes"])
    if (delegateExtra.length > 0) return fail(`unknown key in delegate: ${delegateExtra.join(", ")}`)
    if (typeof entry.kind !== "string" || !SAFE_ID.test(entry.kind)) return fail("delegate kind is invalid")
    if (!Array.isArray(entry.scopes) || !entry.scopes.every((s) => typeof s === "string" && SAFE_ID.test(s))) {
      return fail("delegate scopes are invalid")
    }
    delegates.push({ kind: entry.kind, scopes: entry.scopes as string[] })
  }

  if (typeof raw.issuedAt !== "number") return fail("issuedAt must be a number")
  if (raw.expiresAt === null) {
    // Until the lead session ends: only with a process identity to bind it to.
    if (typeof lead.procStart !== "string" || lead.procStart.length === 0) {
      return fail("a grant without an expiry needs the lead's process identity (lead.procStart)")
    }
  } else {
    if (typeof raw.expiresAt !== "number") return fail("expiresAt must be a number or null")
    if (raw.expiresAt <= now) return fail("grant has expired")
    if (raw.expiresAt - raw.issuedAt > MAX_GRANT_LIFETIME_MS) return fail("grant lifetime exceeds 24h")
  }
  if (raw.issuedBy !== "user:tui" && raw.issuedBy !== "user:cli") return fail("issuedBy must be a user action")

  if (!deps.pidAlive(lead.pid)) return fail("the lead process is not running")
  // Bound to the process, not just its pid: a reused pid is a different session.
  if (typeof lead.procStart === "string") {
    const current = deps.startTime?.(lead.pid)
    if (current === undefined) return fail("could not read the lead process start time, so it cannot be confirmed")
    if (current !== lead.procStart) return fail("the pid is not the process that was designated (it was reused)")
  }

  return {
    ok: true,
    grant: {
      version: 1,
      id: raw.id,
      lead: {
        harness: lead.harness,
        pid: lead.pid,
        ...(typeof lead.sessionID === "string" ? { sessionID: lead.sessionID } : {}),
        ...(typeof lead.address === "string" ? { address: lead.address } : {}),
        ...(typeof lead.name === "string" ? { name: lead.name } : {}),
        ...(typeof lead.procStart === "string" ? { procStart: lead.procStart } : {}),
      },
      scopes,
      delegates,
      issuedAt: raw.issuedAt,
      expiresAt: raw.expiresAt,
      issuedBy: raw.issuedBy,
    },
  }
}

export interface ReadDeps extends ParseDeps {
  now: number
  /** The current user's uid; a file owned by anyone else is not the user's word. */
  uid: number
  /**
   * Defaults to this machine's. On Windows there are no uid or mode bits to check, so
   * those two checks are skipped and the grant relies on the ACLs of the per-user
   * state directory it lives in — stated here because skipping a check silently is
   * the failure this module exists to avoid.
   */
  platform?: NodeJS.Platform
}

/**
 * Reads and validates the grant file. A file anyone else could have written is
 * not the user's authority, so ownership and permissions are part of validity.
 */
export function readGrantFile(path: string, deps: ReadDeps): GrantResult {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return fail("no grant")
  }
  if ((deps.platform ?? process.platform) !== "win32") {
    if (stat.uid !== deps.uid) return fail("grant file is not owned by the current user")
    if ((stat.mode & 0o077) !== 0) return fail("grant file is accessible to group or others")
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fail("grant file is not valid JSON")
  }
  return parseGrant(decoded, deps.now, deps)
}

/** The authenticated sender, as the delivery path resolved it from the socket. */
export interface Sender {
  harness: LeadHarness
  sessionID?: string
  pid?: number
  address?: string
}

export type Verdict =
  | { granted: false; reason: string }
  | {
      granted: true
      grantID: string
      scopes: readonly LeadScope[]
      /** null = until the lead session ends */
      expiresAt: number | null
      via: "lead"
      leadName?: string
    }

/**
 * Whether `sender` is the user's designated lead, and for what.
 *
 * `follow` is the receiver's own standing opt-in (`crew.follow_lead`): without
 * it nothing changes for a session whose user has not asked for a lead.
 * Re-checks expiry because a grant can lapse between being read and being used.
 */
export function verifyLead(
  grant: LeadGrant | undefined,
  sender: Sender,
  opts: { follow: boolean; now: number },
): Verdict {
  if (!grant) return { granted: false, reason: "no grant" }
  if (!opts.follow) return { granted: false, reason: "this session does not follow a lead" }
  if (grant.expiresAt !== null && grant.expiresAt <= opts.now) return { granted: false, reason: "grant has expired" }
  if (sender.harness !== grant.lead.harness) return { granted: false, reason: "sender is not the lead" }

  const same =
    grant.lead.harness === "opencode-skein"
      ? sender.sessionID !== undefined && sender.sessionID === grant.lead.sessionID
      : sender.pid !== undefined &&
        sender.pid === grant.lead.pid &&
        (grant.lead.address === undefined || sender.address === grant.lead.address)
  if (!same) return { granted: false, reason: "sender is not the lead" }

  return {
    granted: true,
    grantID: grant.id,
    scopes: grant.scopes,
    expiresAt: grant.expiresAt,
    via: "lead",
    ...(grant.lead.name ? { leadName: grant.lead.name } : {}),
  }
}

export * as PeerLead from "./lead"
