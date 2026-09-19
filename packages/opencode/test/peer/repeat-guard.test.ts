import { describe, expect, test } from "bun:test"
import { RepeatGuard } from "../../src/peer/repeat-guard"

describe("RepeatGuard", () => {
  test("the first attempt is free and the next identical one is reported as a repeat", () => {
    const guard = new RepeatGuard(60_000)
    expect(guard.record("a", 1_000)).toBe(0)
    expect(guard.record("a", 1_100)).toBe(1)
    expect(guard.record("a", 1_200)).toBe(2)
  })

  test("different keys do not interfere, so one peer's traffic never gates another's", () => {
    const guard = new RepeatGuard(60_000)
    expect(guard.record("a", 1_000)).toBe(0)
    expect(guard.record("b", 1_000)).toBe(0)
  })

  test("a genuine resend after the window is first again, not punished forever", () => {
    const guard = new RepeatGuard(1_000)
    expect(guard.record("a", 1_000)).toBe(0)
    expect(guard.record("a", 2_500)).toBe(0)
  })

  test("memory is bounded, so a runaway sender cannot grow the map without limit", () => {
    const guard = new RepeatGuard(60_000, 2)
    guard.record("a", 1_000)
    guard.record("b", 1_000)
    guard.record("c", 1_000)
    expect(guard.size).toBe(2)
  })

  test("rejects nonsensical construction rather than silently disabling itself", () => {
    expect(() => new RepeatGuard(0)).toThrow()
    expect(() => new RepeatGuard(1_000, 0)).toThrow()
  })
})
