import { describe, expect, test } from "bun:test"
import { InvalidTransition, PeerDelivery, type PeerDeliveryState } from "../../src/peer/delivery-state"

describe("PeerDelivery", () => {
  test("starts accepted", () => {
    const d = new PeerDelivery()
    expect(d.currentState).toBe("accepted")
    expect(d.settled).toBe(false)
    expect(d.acknowledged).toBe(false)
  })

  test("moves accepted to acknowledged to working to replied", () => {
    const d = new PeerDelivery()
    d.transition("acknowledged")
    d.transition("working")
    d.transition("replied")
    expect(d.currentState).toBe("replied")
    expect(d.settled).toBe(true)
    expect(d.transitions).toEqual([
      { from: "accepted", to: "acknowledged" },
      { from: "acknowledged", to: "working" },
      { from: "working", to: "replied" },
    ])
  })

  test("acknowledged and working are observable but do not settle", () => {
    const d = new PeerDelivery()
    d.transition("acknowledged")
    expect(d.acknowledged).toBe(true)
    expect(d.settled).toBe(false)
    d.transition("working")
    expect(d.settled).toBe(false)
    expect(d.currentState).toBe("working")
  })

  test("a terminal state rejects any further transition", () => {
    const d = new PeerDelivery()
    d.transition("working")
    d.transition("timed out")
    expect(d.currentState).toBe("timed out")
    expect(() => d.transition("replied")).toThrow(InvalidTransition)
    expect(() => d.transition("working")).toThrow(InvalidTransition)
    // The late-reply-after-timeout case the spec calls out specifically.
    expect(() => d.transition("replied")).toThrow("cannot move from \"timed out\" to \"replied\"")
  })

  test("a late reply after a timeout is recorded as superseded, not replied", () => {
    const d = new PeerDelivery()
    d.transition("working")
    d.transition("timed out")
    const before = d.currentState
    // The state machine refuses the flip; the caller records the superseded
    // reply against the terminal state rather than moving.
    expect(() => d.transition("replied")).toThrow()
    expect(d.currentState).toBe(before)
  })

  test("each terminal path settles exactly once", () => {
    // reached: the states you can transition straight into from accepted
    const reachableTerminal: Array<[PeerDeliveryState, PeerDeliveryState]> = [
      ["replied", "accepted"],
      ["replied", "working"],
      ["failed", "working"],
      ["timed out", "working"],
      ["unreachable", "working"],
    ]
    for (const [terminal, from] of reachableTerminal) {
      const d = new PeerDelivery()
      d.transition(from)
      d.transition(terminal)
      expect(d.settled).toBe(true)
      expect(() => d.transition("working")).toThrow()
    }
  })

  test("unreachable terminates a working conversation", () => {
    const d = new PeerDelivery()
    d.transition("working")
    d.transition("unreachable")
    expect(d.currentState).toBe("unreachable")
    expect(() => d.transition("replied")).toThrow()
  })

  test("skipping working (accepted to failed) is allowed", () => {
    const d = new PeerDelivery()
    d.transition("failed")
    expect(d.currentState).toBe("failed")
    expect(() => d.transition("acknowledged")).toThrow()
  })

  test("a no-op transition into the current state does not record a history entry", () => {
    const d = new PeerDelivery()
    d.transition("acknowledged")
    d.transition("acknowledged")
    expect(d.transitions).toHaveLength(1)
  })
})
