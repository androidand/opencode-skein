import { describe, expect, test } from "bun:test"
import { TextRepeatDetector } from "@/session/repeat-detect"

const feedAll = (parts: string[]) => {
  const d = new TextRepeatDetector()
  for (const p of parts) {
    const hit = d.feed(p)
    if (hit) return hit
  }
  return undefined
}

describe("TextRepeatDetector", () => {
  test("the same sentence three times fires as a same-fragment", () => {
    const line = "Still waiting for the build to finish.\n"
    expect(feedAll([line, line, line, line])?.kind).toBe("same-fragment")
  })

  test("a two-sentence line repeated fires (as a pair)", () => {
    const line = "The subagent is still running. I'll wait for the notification.\n"
    expect(feedAll([line, line, line, line])).toBeDefined()
  })

  test("two alternating sentences fire as a pair", () => {
    const a = "Still waiting for the build to finish.\n"
    const b = "Checking the status of the task again.\n"
    expect(feedAll([a, b, a, b, a, b])?.kind).toBe("paired-fragments")
  })

  test("varied prose and short repeated lines do not fire", () => {
    const prose = Array.from({ length: 30 }, (_, i) => `Step ${i} done and the result number ${i * 3} looks right.\n`)
    expect(feedAll(prose)).toBeUndefined()
    expect(feedAll(["ok.\n", "ok.\n", "ok.\n", "ok.\n"])).toBeUndefined()
  })

  test("fires once only", () => {
    const d = new TextRepeatDetector()
    const line = "The subagent is still running. I'll wait for the notification.\n"
    const hits = [line, line, line, line, line].map((l) => d.feed(l)).filter(Boolean)
    expect(hits).toHaveLength(1)
  })
})
