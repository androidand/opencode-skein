import { describe, expect, test } from "bun:test"
import { findRunaway } from "@/session/runaway-detect"

const spam = "</parameter>\n</invoke>\n"

describe("findRunaway", () => {
  test("invoke spam after a finished answer is cut after the first instance", () => {
    const answer = "Task 1 complete.\n<promise>COMPLETE</promise>\n"
    const hit = findRunaway(answer + spam.repeat(600))
    expect(hit).toBeDefined()
    expect(hit!.keep).toBe((answer + spam).length)
  })

  test("fires early enough to matter, not after thousands of repeats", () => {
    expect(findRunaway("ok\n" + spam.repeat(25))).toBeDefined()
    expect(findRunaway("ok\n" + spam.repeat(10))).toBeUndefined()
  })

  test("single character runs", () => {
    expect(findRunaway("x" + "a".repeat(500))).toBeDefined()
  })

  test("an 80 char rule and a table are left alone", () => {
    expect(findRunaway("title\n" + "-".repeat(80) + "\n")).toBeUndefined()
    const table = "| a | b |\n|---|---|\n" + "| 1 | 2 |\n".repeat(8)
    expect(findRunaway(table)).toBeUndefined()
  })

  test("whitespace-only repetition is not a runaway", () => {
    expect(findRunaway("code\n" + " ".repeat(2000))).toBeUndefined()
    expect(findRunaway("code\n" + "\n".repeat(2000))).toBeUndefined()
  })

  test("normal prose and code are left alone", () => {
    const prose = Array.from({ length: 200 }, (_, i) => `Line ${i}: the quick brown fox jumps over ${i * 7} lazy dogs.`).join("\n")
    expect(findRunaway(prose)).toBeUndefined()
  })
})
