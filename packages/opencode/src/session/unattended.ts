import type { SessionID } from "./schema"

// Sessions with nobody available to answer a permission prompt: a `/loop`
// run's own session, and every subagent spawned under one while it runs.
// `Permission.ask` blocks on a Deferred with no timeout (see
// `permission/index.ts`) — an unattended session that hits an `ask` rule
// (e.g. a role's own `websearch: "ask"`) hangs forever, since nothing ever
// calls `reply()`. Marking a session here makes `ask` auto-allow instead.
//
// This never touches `deny` — a role's or QueueDenyRules' explicit denial
// still fails the call immediately, exactly as before. Only the undecided
// "ask" default changes.
const sessions = new Set<SessionID>()

export function mark(sessionID: SessionID): void {
  sessions.add(sessionID)
}

export function unmark(sessionID: SessionID): void {
  sessions.delete(sessionID)
}

export function isUnattended(sessionID: SessionID): boolean {
  return sessions.has(sessionID)
}

export * as Unattended from "./unattended"
