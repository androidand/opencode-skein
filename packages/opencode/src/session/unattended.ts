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
//
// Two things worth stating rather than assuming:
//   - "scoped by default" holds unless `auto_mode` is on: a global auto mode means full auto for
//     every session (see `toolAskVerdict`), and `policyFromConfig` maps `auto_mode: true` to "full".
//     So `off` is only reachable when auto mode is off, and a marked session's own `off` does not
//     override a global auto mode.
//   - Scoped does not only settle UNDECIDED asks, it settles asks an agent put there on purpose.
//     The built-in agent allows everything and asks only about doom_loop, directories outside the
//     project, and secret files (`*.env`, `*.env.*`). Those asks exist to put a human in front of
//     something, so scoped REFUSES them rather than waving them through: an unattended run is told
//     no, and carries on.
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
])

// Files whose read or edit the built-in agent asks about on purpose (`*.env`, `*.env.*`, with
// `*.env.example` exempt), plus the obvious private-key and credential files. An unattended run is
// refused these instead of being handed them: nobody is there to say yes.
const SENSITIVE: readonly RegExp[] = [
  /(^|[\\/])\.env(\..+)?$/i,
  /\.env$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|[\\/])\.(netrc|npmrc|pypirc)$/i,
  /(^|[\\/])credentials(\.json)?$/i,
]
const NOT_SENSITIVE: readonly RegExp[] = [/\.env\.(example|sample|template)$/i]

export function isSensitivePath(pattern: string): boolean {
  if (NOT_SENSITIVE.some((rx) => rx.test(pattern))) return false
  return SENSITIVE.some((rx) => rx.test(pattern))
}

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

/**
 * The rule shown to the model when an unattended session is refused something. It names the
 * way out, so the agent decides without the permission or records the need, instead of retrying.
 */
export function refusalRule(permission: string) {
  return {
    permission,
    pattern: "*",
    action: `deny: "${permission}" is not available in an unattended run. Decide without it, or record the need in the change's .skein/blocker.md and move on.`,
  }
}

/**
 * What the TOOL layer does with an undecided ask (session/tools.ts), which sits in front of
 * `Permission.ask`. It matters because that layer used to skip the question entirely for a queue
 * session (one carrying the push-deny ceiling) and for global auto mode, so the unattended policy
 * was never consulted for the main swarm mode.
 *
 *   global auto mode            allow   (full auto, honoured for every session)
 *   a marked unattended session its policy decides: scoped allows a closed list and refuses the
 *                               rest, full allows, off asks a human
 *   unmarked, with the ceiling  allow   (the earlier behaviour, kept as a fallback)
 *   otherwise                   ask
 *
 * Explicit denies are evaluated before this is reached, and always win.
 */
export function toolAskVerdict(input: {
  policy: Policy | undefined
  permission: string
  patterns?: readonly string[]
  autoEnabled: boolean
  queueCeiling: boolean
}): Verdict {
  if (input.autoEnabled) return "allow"
  if (input.policy) return decide(input.policy, input.permission, input.patterns)
  return input.queueCeiling ? "allow" : "ask"
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

/**
 * What to do with an undecided ask. `undefined` policy means the session is not unattended.
 * `patterns` are what the ask is about (file paths, commands): a scoped session is refused a read or
 * edit of a secret file even though `read` and `edit` are otherwise on its list.
 */
export function decide(policy: Policy | undefined, permission: string, patterns: readonly string[] = []): Verdict {
  if (!policy || policy.mode === "off") return "ask"
  if (policy.mode === "full") return "allow"
  if ((permission === "read" || permission === "edit") && patterns.some(isSensitivePath)) return "deny"
  return ScopedAllow.has(permission) || policy.extraAllow.includes(permission) ? "allow" : "deny"
}

export * as Unattended from "./unattended"
