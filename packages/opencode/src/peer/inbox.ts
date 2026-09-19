// A busy target's turn cannot be joined or raced, so send_peer_message and the
// inbound sidecar path both refuse to inject into one mid-turn. Refusing was
// the whole fix that shipped tonight — nothing then delivered the message once
// the turn ended. For a turn that runs tens of minutes (not the rare
// exception it was designed around), that refusal is a silent, indefinite gap
// in both directions: a reply to a genuinely busy peer never arrives, and the
// caller has no way to know when to retry short of polling, which this same
// tool's own description tells the model never to do.
//
// This is that missing half: hold what could not be delivered, and run it the
// moment the target session reports idle. `session/status.ts` drains from
// inside `set()`, at the exact point it already publishes `Event.Idle` — the
// same signal everything else in this codebase already treats as "safe to
// inject now".
import { Effect } from "effect"

// `unknown` on the error channel rather than `never`: a queued delivery is
// built by the sender's own tool call or the inbound sidecar path, each
// closing over an operation (`SessionPrompt.prompt`) that can genuinely fail.
// `drain`'s caller is responsible for catching it — see status.ts.
export type PendingDelivery = () => Effect.Effect<void, unknown>

/**
 * A session that never goes idle (or a caller that keeps sending into one)
 * must not grow this without bound. Twenty is generous for "held during one
 * long turn" and stingy for "a queue" — if this fills, the thing to fix is
 * upstream (the duplicate-send guard, the model's own judgment), not the cap.
 */
const MaxPendingPerSession = 20

const pending = new Map<string, PendingDelivery[]>()

/** Holds a delivery for later. The oldest entry is dropped on overflow, not the newest — see the cap's own reasoning. */
export function enqueue(sessionID: string, run: PendingDelivery): void {
  const list = pending.get(sessionID) ?? []
  list.push(run)
  while (list.length > MaxPendingPerSession) list.shift()
  pending.set(sessionID, list)
}

export function pendingCount(sessionID: string): number {
  return pending.get(sessionID)?.length ?? 0
}

/** Removes and returns everything held for a session, oldest first. Empty when nothing was waiting. */
export function drain(sessionID: string): PendingDelivery[] {
  const list = pending.get(sessionID)
  if (!list || list.length === 0) return []
  pending.delete(sessionID)
  return list
}

export * as PeerInbox from "./inbox"
