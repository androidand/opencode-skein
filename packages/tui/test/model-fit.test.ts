import { expect, test } from "bun:test"
import {
  aboveCeiling,
  computeRecommendedCtx,
  MAX_CTX,
  memoryOptionDescription,
  memoryOptionTitle,
  MIN_WORKFLOW_CTX,
  PRESETS,
} from "../src/local/model-fit"

function mem(overrides: Partial<Parameters<typeof computeRecommendedCtx>[0]> = {}) {
  return {
    freeMb: 0,
    totalMb: 24560,
    usedMb: 0,
    label: "VRAM",
    modelMb: 8000,
    kvEstMb: 1024,
    ...overrides,
  }
}

test("returns null without enough signal", () => {
  expect(computeRecommendedCtx(mem({ kvEstMb: 0 }), 32768)).toBeNull()
  expect(computeRecommendedCtx(mem(), 0)).toBeNull()
})

test("scales the KV budget by the current hard ctx", () => {
  // 1024 MB KV at 32k + 1024 MB free → 2× the ctx.
  expect(computeRecommendedCtx(mem({ freeMb: 1024 }), 32768)).toBe(65536)
})

test("clamps to the workflow range when no ceiling is known", () => {
  expect(computeRecommendedCtx(mem({ freeMb: 0 }), 8192)).toBe(MIN_WORKFLOW_CTX)
  expect(computeRecommendedCtx(mem({ freeMb: 1_000_000 }), 32768)).toBe(MAX_CTX)
})

test("never recommends above max_fit_ctx", () => {
  // Plenty of free VRAM but max_fit_ctx says 32k is the VRAM limit.
  // Uncapped this returned ~250k.
  expect(computeRecommendedCtx(mem({ freeMb: 1_000_000 }), 32768)).toBe(MAX_CTX)
  expect(computeRecommendedCtx(mem({ freeMb: 1_000_000 }), 32768, 32768)).toBe(32768)
})

test("the ceiling outranks the workflow floor", () => {
  // max_fit_ctx 32k means VRAM only supports 32k; recommending above that
  // writes a --ctx-size the backend cannot load.
  expect(computeRecommendedCtx(mem({ freeMb: 0 }), 8192, 32768)).toBe(32768)
})

test("an unknown ceiling caps nothing", () => {
  expect(computeRecommendedCtx(mem({ freeMb: 1024 }), 32768, 0)).toBe(65536)
  expect(computeRecommendedCtx(mem({ freeMb: 1024 }), 32768, undefined)).toBe(65536)
})

test("aboveCeiling only fires on a known ceiling", () => {
  expect(aboveCeiling(98304, 32768)).toBe(true)
  expect(aboveCeiling(32768, 32768)).toBe(false)
  expect(aboveCeiling(4096, 32768)).toBe(false)
  expect(aboveCeiling(98304, 0)).toBe(false)
  expect(aboveCeiling(98304, undefined)).toBe(false)
})

test("PRESETS offers sizes above a typical VRAM ceiling", () => {
  // Guards the premise of the fix: the hand-authored preset list reaches far
  // past what a host with 32k max_fit_ctx can load, so the ceiling annotation
  // must exist.
  expect(PRESETS.filter((n) => aboveCeiling(n, 32768)).length).toBeGreaterThan(0)
  expect(PRESETS).toContain(98304)
})

test("memory option labels name the change and its cost classes", () => {
  const q4 = {
    id: "kv-v-q4",
    overrides: { cache_type_k: "q8_0", cache_type_v: "q4_0" },
    cost: { quality: "minor", speed: "none" },
    requires_flags: ["--flash-attn on"],
  }
  expect(memoryOptionTitle(q4)).toBe("KV cache K q8_0 / V q4_0")
  expect(memoryOptionDescription(q4)).toBe("quality: minor · needs --flash-attn on")

  const host = {
    id: "kv-host",
    overrides: { cache_type_k: "q4_0", cache_type_v: "q4_0", kv_offload: false },
    cost: { quality: "moderate", speed: "major" },
  }
  expect(memoryOptionTitle(host)).toBe("KV cache q4_0 + KV cache in RAM")
  expect(memoryOptionDescription(host)).toBe("quality: moderate · speed: major")

  const dense = {
    id: "offload",
    overrides: { cache_type_k: "q4_0", cache_type_v: "q4_0", n_gpu_layers: 40 },
    cost: { quality: "moderate", speed: "major" },
    pins_placement: true,
  }
  expect(memoryOptionDescription(dense)).toContain("pins GPU layer placement")
  expect(memoryOptionTitle({ id: "current", overrides: {}, cost: { quality: "none", speed: "none" } })).toBe(
    "Keep current settings",
  )
})
