import { describe, expect, test } from "bun:test"
import { RecentIDs } from "../../src/peer/recent-ids"

describe("RecentIDs", () => {
  test("admits an id once and refuses its repeats", () => {
    const recent = new RecentIDs(8)
    expect(recent.admit("a")).toBe(true)
    expect(recent.admit("a")).toBe(false)
    expect(recent.admit("b")).toBe(true)
  })

  test("forgets the oldest id once over capacity, so memory is bounded", () => {
    const recent = new RecentIDs(2)
    recent.admit("a")
    recent.admit("b")
    recent.admit("c")
    expect(recent.size).toBe(2)
    // "a" was evicted; a replay of it now looks new — that is the accepted
    // trade for a bounded set, and why capacity outlasts a retry window.
    expect(recent.admit("a")).toBe(true)
    expect(recent.admit("c")).toBe(false)
  })

  test("rejects a nonsensical capacity", () => {
    expect(() => new RecentIDs(0)).toThrow()
  })
})
