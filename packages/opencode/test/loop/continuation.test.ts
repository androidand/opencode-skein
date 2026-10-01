import { describe, expect, test } from "bun:test"
import { continuationPrompt } from "@/loop/continuation"

const BASE = "keep working through the task list"

describe("continuationPrompt", () => {
  test("first iteration returns the base prompt unchanged", () => {
    expect(continuationPrompt(BASE, undefined)).toBe(BASE)
  })

  test("normal progress returns the base prompt unchanged", () => {
    expect(continuationPrompt(BASE, { toolCalls: 4, outputLength: 900, wasNearIdentical: false })).toBe(BASE)
  })

  test("stall (no tools, short output) prepends the execute directive", () => {
    const out = continuationPrompt(BASE, { toolCalls: 0, outputLength: 20, wasNearIdentical: false })
    expect(out).toContain("used no tools")
    expect(out).toContain(BASE)
    expect(out.endsWith(BASE)).toBe(true)
  })

  test("empty output prepends the empty-response directive", () => {
    const out = continuationPrompt(BASE, { toolCalls: 0, outputLength: 0, wasNearIdentical: false })
    expect(out).toContain("previous response was empty")
    expect(out).toContain(BASE)
  })

  test("spinning (tools but near-identical output) prepends the reassess directive", () => {
    const out = continuationPrompt(BASE, { toolCalls: 3, outputLength: 500, wasNearIdentical: true })
    expect(out).toContain("repeating the same actions")
    expect(out).toContain(BASE)
  })

  test("a substantive no-tool answer is not treated as a stall", () => {
    expect(continuationPrompt(BASE, { toolCalls: 0, outputLength: 400, wasNearIdentical: false })).toBe(BASE)
  })
})

describe("continuationPrompt — stops that handed the work to someone who is not coming back", () => {
  test("a turn that asked the user gets the ladder ahead of the base prompt", () => {
    const out = continuationPrompt(BASE, { toolCalls: 5, outputLength: 400, wasNearIdentical: false, stop: "asking-user" })
    expect(out).toContain("Do not stop to ask")
    expect(out.endsWith(BASE)).toBe(true)
  })
  test("a turn that waited on a peer gets the ladder, not the stall directive", () => {
    const out = continuationPrompt(BASE, { toolCalls: 0, outputLength: 20, wasNearIdentical: false, stop: "waiting-on-peer" })
    expect(out).toContain("ONE request to the lead")
    expect(out).not.toContain("used no tools")
  })
  test("an ordinary turn is untouched", () => {
    expect(continuationPrompt(BASE, { toolCalls: 4, outputLength: 900, wasNearIdentical: false, stop: "other" })).toBe(BASE)
  })
})
