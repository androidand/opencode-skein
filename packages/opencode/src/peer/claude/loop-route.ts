import { Effect } from "effect"
import type { Loop } from "@/loop/loop"
import { parsePeerEnvelope } from "@/peer/envelope"
import { claudePidOf } from "@/peer/route"

/** The inbound fields loop routing needs. */
export interface LoopInbound {
  sessionID: string
  text: string
  from?: string
  fromName?: string
}

/**
 * Hands an inbound peer message to the target session's crew loop, when that
 * session has a loop that will run again (running or paused). Returns true
 * when the loop took the message; false means the caller must deliver it
 * another way.
 *
 * `loop.list()` also returns loops that have finished, and `loop.inbox()`
 * refuses those. Routing on "the session has a loop" alone therefore dropped
 * every message sent to a session whose loop had already completed — exactly
 * the idle sessions a peer most wants to reach — without a log line.
 */
export const deliverToLoop = (loop: Pick<Loop.Interface, "list" | "inbox">, inbound: LoopInbound) =>
  Effect.gen(function* () {
    const active = (yield* loop.list()).find(
      (l) => l.sessionID === inbound.sessionID && (l.status === "running" || l.status === "paused"),
    )
    if (!active) return false
    const mode = parsePeerEnvelope(inbound.text)?.envelope.mode === "request" ? "request" : "notify"
    const pid = claudePidOf(inbound.from)
    return yield* loop.inbox({
      loopID: active.id,
      from: { harness: "claude-code", id: pid ?? "unknown", name: inbound.fromName },
      mode,
      text: inbound.text,
    })
  })
