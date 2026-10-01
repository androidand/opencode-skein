import type { SessionID } from "./schema"

// Sessions with nobody available to answer a permission prompt: a `/loop`
// run's own session, and every subagent spawned under one while it runs.
// `Permission.ask` blocks on a Deferred with no timeout (see
// `permission/index.ts`) — an unattended session that hits an `ask` rule
// (e.g. a role's own `websearch: "ask"`) hangs forever, since nothing ever
// calls `reply()`.
//
// So an unattended session needs a policy for the undecided "ask". Always
// allowing it (the first version) removes the hang and also removes the human
// from every decision a loop makes. The default is therefore SCOPED: allow what
// an agent needs inside its own project, refuse what reaches outside it, and say
// so — the agent gets an answer and routes around, rather than hanging or being
// handed authority nobody chose to give.
//
//   scoped  allow a closed list of in-project permissions; refuse the rest  (default)
//   full    allow every undecided ask — "full auto", an explicit choice
//   off     leave the question for a human, as before any of this existed
//
// None of this touches `deny`. An explicit denial — a role's, or QueueDenyRules' —
// is decided before this is consulted and always wins.
export type Mode = "scoped" | "full" | "off"

export interface Policy {
  readonly mode: Mode
  /** Extra permission names a scoped session may use, e.g. ["webfetch", "websearch"] for a research agent. */
  readonly extraAllow: readonly string[]
}

export type Verdict = "allow" | "deny" | "ask"

export const DefaultPolicy: Policy = { mode: "scoped", extraAllow: [] }

// What an agent working in its own project needs. A CLOSED list: a permission this
// file has never heard of is refused, so a new kind of ask is never granted by
// accident. Not on it, on purpose: external_directory (outside the project),
// webfetch/websearch (the network; opt in with extraAllow), plan_enter (an
// unattended agent switching to a mode that stops executing), and MCP tools.
export const ScopedAllow: ReadonlySet<string> = new Set([
  "bash",
  "read",
  "edit",
  "glob",
  "grep",
  "lsp",
  "todowrite",
  "task",
  "skill",
  "doom_loop",
])

/**
 * The policy a loop run uses, from config. `experimental.unattended_permissions` decides;
 * without it, `auto_mode: true` means full auto and everything else means scoped.
 * Anything unrecognised falls back to scoped, never to a wider mode.
 */
export function policyFromConfig(cfg: {
  auto_mode?: boolean
  experimental?: { unattended_permissions?: string; unattended_allow?: readonly string[] }
}): Policy {
  const asked = cfg.experimental?.unattended_permissions
  const mode: Mode = asked === "full" || asked === "off" || asked === "scoped" ? asked : cfg.auto_mode ? "full" : "scoped"
  return { mode, extraAllow: (cfg.experimental?.unattended_allow ?? []).filter((x) => typeof x === "string") }
}

const sessions = new Map<SessionID, Policy>()

export function mark(sessionID: SessionID, policy: Policy = DefaultPolicy): void {
  sessions.set(sessionID, policy)
}

export function unmark(sessionID: SessionID): void {
  sessions.delete(sessionID)
}

export function isUnattended(sessionID: SessionID): boolean {
  return sessions.has(sessionID)
}

export function policyOf(sessionID: SessionID): Policy | undefined {
  return sessions.get(sessionID)
}

/** What to do with an undecided ask. `undefined` policy means the session is not unattended. */
export function decide(policy: Policy | undefined, permission: string): Verdict {
  if (!policy || policy.mode === "off") return "ask"
  if (policy.mode === "full") return "allow"
  return ScopedAllow.has(permission) || policy.extraAllow.includes(permission) ? "allow" : "deny"
}

export * as Unattended from "./unattended"
