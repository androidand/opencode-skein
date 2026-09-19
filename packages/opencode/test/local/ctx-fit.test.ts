// The numbers here are a real refusal captured from a host on 2026-09-18:
// a 24 GB card, weights 19281 MB, a VRAM estimate of 28949 MB at a configured
// 262144 context, and no computable max_fit_ctx.
import { describe, expect, test } from "bun:test"
import { contextThatFits, roundDownContext } from "../../src/local/ctx-fit"

const capturedHost = {
  configured_ctx: 262144,
  max_fit_ctx: null,
  vram_required_mb: 28949,
  vram_total_mb: 24560,
  model_mb: 19281,
}

describe("contextThatFits", () => {
  test("derives a smaller context when the host could not compute a ceiling", () => {
    const target = contextThatFits(capturedHost)
    expect(target).toBeDefined()
    expect(target!).toBeLessThan(262144)
    expect(target! % 1024).toBe(0)
    // Weights plus the derived context's share must land inside the budget.
    const scales = capturedHost.vram_required_mb - capturedHost.model_mb
    const projected = capturedHost.model_mb + scales * (target! / capturedHost.configured_ctx)
    expect(projected).toBeLessThanOrEqual(capturedHost.vram_total_mb * 0.9)
  })

  test("prefers the host's own ceiling whenever it reported one", () => {
    expect(contextThatFits({ ...capturedHost, max_fit_ctx: 125102 })).toBe(roundDownContext(125102))
  })

  test("gives up when the weights alone overrun the card", () => {
    expect(contextThatFits({ ...capturedHost, model_mb: 24000 })).toBeUndefined()
  })

  test("gives up when the shortfall is not context-driven", () => {
    // Nothing above the weights, so shrinking context cannot recover anything.
    expect(contextThatFits({ ...capturedHost, vram_required_mb: capturedHost.model_mb })).toBeUndefined()
  })

  test("gives up rather than proposing a uselessly small context", () => {
    expect(contextThatFits(capturedHost, { minContext: 200_000 })).toBeUndefined()
  })

  test("never proposes a context that is not actually smaller", () => {
    expect(contextThatFits({ ...capturedHost, vram_required_mb: 19282, configured_ctx: 4096 })).toBeUndefined()
  })

  test("an incomplete report yields nothing rather than a guess", () => {
    expect(contextThatFits({})).toBeUndefined()
    expect(contextThatFits({ configured_ctx: 262144 })).toBeUndefined()
  })
})

describe("roundDownContext", () => {
  test("rounds down to whole 1024-token blocks", () => {
    expect(roundDownContext(131071)).toBe(130048)
    expect(roundDownContext(1024)).toBe(1024)
    expect(roundDownContext(1023)).toBe(0)
  })
})
