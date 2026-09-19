import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PeerInbox } from "../../src/peer/inbox"

describe("PeerInbox", () => {
  test("drain returns nothing for a session that was never enqueued", () => {
    expect(PeerInbox.drain("ses_never_seen")).toEqual([])
  })

  test("a delivery held for a busy target runs, in order, once drained", async () => {
    const sessionID = "ses_order_test"
    const ran: number[] = []
    PeerInbox.enqueue(sessionID, () => Effect.sync(() => void ran.push(1)))
    PeerInbox.enqueue(sessionID, () => Effect.sync(() => void ran.push(2)))
    expect(PeerInbox.pendingCount(sessionID)).toBe(2)

    const drained = PeerInbox.drain(sessionID)
    expect(drained).toHaveLength(2)
    for (const run of drained) await Effect.runPromise(run())
    expect(ran).toEqual([1, 2])
  })

  test("draining empties the queue — a second drain sees nothing left", () => {
    const sessionID = "ses_drain_once"
    PeerInbox.enqueue(sessionID, () => Effect.void)
    expect(PeerInbox.drain(sessionID)).toHaveLength(1)
    expect(PeerInbox.drain(sessionID)).toEqual([])
    expect(PeerInbox.pendingCount(sessionID)).toBe(0)
  })

  test("one session's queue never affects another's", () => {
    PeerInbox.enqueue("ses_a", () => Effect.void)
    expect(PeerInbox.pendingCount("ses_b")).toBe(0)
    expect(PeerInbox.drain("ses_a")).toHaveLength(1)
  })

  test("a session that never goes idle does not grow the queue without bound", () => {
    const sessionID = "ses_overflow"
    for (let i = 0; i < 30; i++) PeerInbox.enqueue(sessionID, () => Effect.void)
    // Bounded, not 30 — the exact cap is an implementation detail; what
    // matters is that a stuck session cannot leak memory forever.
    expect(PeerInbox.pendingCount(sessionID)).toBeLessThan(30)
    expect(PeerInbox.pendingCount(sessionID)).toBeGreaterThan(0)
  })

  test("overflow drops the oldest entry, not the newest", async () => {
    const sessionID = "ses_overflow_order"
    const ran: number[] = []
    for (let i = 0; i < 25; i++) {
      PeerInbox.enqueue(sessionID, () => Effect.sync(() => void ran.push(i)))
    }
    const drained = PeerInbox.drain(sessionID)
    for (const run of drained) await Effect.runPromise(run())
    // Entry 0 is gone; the most recent entries survive.
    expect(ran).not.toContain(0)
    expect(ran).toContain(24)
  })
})
