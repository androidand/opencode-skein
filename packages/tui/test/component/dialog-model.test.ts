import { expect, test } from "bun:test"
import { matchProviderByNeedle } from "../../src/component/dialog-model"

const providers = [
  { id: "opencode", name: "opencode" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "gpuhost4", name: "gpuhost4" },
  { id: "gpuhost5", name: "gpuhost5" },
  { id: "gpuhost2", name: "gpuhost2" },
]

test("exact id match wins outright", () => {
  expect(matchProviderByNeedle(providers, "gpuhost4")?.id).toBe("gpuhost4")
})

test("is case-insensitive", () => {
  expect(matchProviderByNeedle(providers, "M3")?.id).toBe("gpuhost4")
  expect(matchProviderByNeedle(providers, "OPENCODE")?.id).toBe("opencode")
})

test("falls back to a prefix hit on id or name", () => {
  expect(matchProviderByNeedle(providers, "open")?.id).toBe("opencode")
})

test("exact match beats a prefix match on a different, longer id", () => {
  // "gpuhost4" must not be shadowed by some other provider whose id merely starts with it.
  const withPrefixCollision = [...providers, { id: "m30-legacy", name: "m30-legacy" }]
  expect(matchProviderByNeedle(withPrefixCollision, "gpuhost4")?.id).toBe("gpuhost4")
})

test("returns undefined when nothing matches", () => {
  expect(matchProviderByNeedle(providers, "gpt")).toBeUndefined()
})
