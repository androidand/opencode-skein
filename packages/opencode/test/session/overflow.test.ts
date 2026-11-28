import { afterEach, describe, expect, test } from "bun:test"
import { isOverflow, usable } from "@/session/overflow"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const cfg = (compaction: Record<string, unknown> = {}) => ({ compaction }) as never

const model = (limit: { context: number; output: number }) =>
  ({
    id: ModelV2.ID.make("fit-model"),
    providerID: ProviderV2.ID.make("test"),
    limit: { context: limit.context, output: limit.output, input: undefined },
  }) as never

const FIT_MODEL = { context: 67_174, output: 8_192 }

afterEach(() => {
  Provider.noteFitDerivedContext("test", "fit-model", false)
})

describe("usable", () => {
  test("a fit-derived context deducts only the small buffer, not the reply allowance again", () => {
    Provider.noteFitDerivedContext("test", "fit-model", true)
    expect(usable({ cfg: cfg(), model: model(FIT_MODEL) })).toBe(65_126)
  })

  test("an explicit compaction.reserved wins over the fit-derived buffer", () => {
    Provider.noteFitDerivedContext("test", "fit-model", true)
    expect(usable({ cfg: cfg({ reserved: 4_096 }), model: model(FIT_MODEL) })).toBe(63_078)
  })

  test("a model whose limit did not come from a fit report keeps the existing rule", () => {
    expect(usable({ cfg: cfg(), model: model(FIT_MODEL) })).toBe(58_982)
  })

  test("clearing the fit verdict restores the existing rule", () => {
    Provider.noteFitDerivedContext("test", "fit-model", true)
    Provider.noteFitDerivedContext("test", "fit-model", false)
    expect(usable({ cfg: cfg(), model: model(FIT_MODEL) })).toBe(58_982)
  })

  test("a zero context is still zero usable", () => {
    Provider.noteFitDerivedContext("test", "fit-model", true)
    expect(usable({ cfg: cfg(), model: model({ context: 0, output: 8_192 }) })).toBe(0)
  })
})

const tokens = (n: number) => ({ input: n, output: 0, cache: { read: 0, write: 0 } }) as never

describe("isOverflow against a fit-derived budget", () => {
  test("the trigger sits at the fit-derived threshold, not the double-deducted one", () => {
    Provider.noteFitDerivedContext("test", "fit-model", true)
    const m = model(FIT_MODEL)
    expect(isOverflow({ cfg: cfg(), tokens: tokens(58_982), model: m })).toBe(false)
    expect(isOverflow({ cfg: cfg(), tokens: tokens(65_125), model: m })).toBe(false)
    expect(isOverflow({ cfg: cfg(), tokens: tokens(65_126), model: m })).toBe(true)
  })

  test("an explicit compaction.reserved moves the trigger to the configured number", () => {
    Provider.noteFitDerivedContext("test", "fit-model", true)
    const m = model(FIT_MODEL)
    expect(isOverflow({ cfg: cfg({ reserved: 4_096 }), tokens: tokens(63_077), model: m })).toBe(false)
    expect(isOverflow({ cfg: cfg({ reserved: 4_096 }), tokens: tokens(63_078), model: m })).toBe(true)
  })
})
