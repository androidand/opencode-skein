import { describe, expect, test } from "bun:test"
import type { ModelFit } from "../src/local/llama-skein/gen/types.gen"
import { aboveCeiling, computeRecommendedCtx, describePlacement, parseGpuLayers, placementAction, placementIndicator, MAX_CTX, MIN_WORKFLOW_CTX, PRESETS } from "../src/local/model-fit"

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

describe("describePlacement", () => {
  test("offloaded weights report the GPU/RAM split and flag host-paced classes", () => {
    const base = { model: "m", gpu_resident_mb: 30720, host_resident_mb: 20480 } as ModelFit
    expect(describePlacement(base)).toBe("weights 30.0 GB GPU + 20.0 GB RAM (offloaded)")
    expect(describePlacement({ ...base, placement: { perf_class: "cpu-bound-hybrid" } } as ModelFit)).toBe(
      "weights 30.0 GB GPU + 20.0 GB RAM (offloaded, slow)",
    )
  })
  test("a pinned command says offload is off; plain GPU says nothing", () => {
    expect(describePlacement({ model: "m", placement: { mode: "custom" } } as ModelFit)).toContain("pinned off")
    expect(describePlacement({ model: "m", host_resident_mb: 0, placement: { mode: "gpu" } } as ModelFit)).toBeNull()
    expect(describePlacement(null)).toBeNull()
  })
})

describe("placementAction", () => {
  const pinned = (alt: Record<string, unknown> | undefined) =>
    ({ model: "m", placement: { mode: "custom", if_unpinned: alt } }) as unknown as ModelFit

  test("nothing to offer for an unpinned, unknown or alternative-less model", () => {
    expect(placementAction(null)).toBeNull()
    expect(placementAction({ model: "m", placement: { mode: "gpu" } } as ModelFit)).toBeNull()
    expect(placementAction(pinned(undefined))).toBeNull()
  })
  test("pinned but fits on the GPU anyway → drop the pin", () => {
    const a = placementAction(pinned({ mode: "gpu", loadable: true }))!
    expect(a.kind).toBe("unpin")
    expect(a.title).toBe("Remove the placement pin")
    expect(a.description).toContain("reloads the model")
  })
  test("pinned and only loadable with offload → says how much RAM and whether it is slow", () => {
    const a = placementAction(pinned({ mode: "hybrid", loadable: true, est_host_mb: 20480, perf_class: "cpu-bound-hybrid" }))!
    expect(a.kind).toBe("unpin")
    expect(a.description).toContain("~20.0 GB")
    expect(a.description).toContain("slow")
  })
  test("won't load even unpinned → info only, never an action", () => {
    const a = placementAction(pinned({ mode: "refuse", loadable: false }))!
    expect(a.kind).toBe("info")
    expect(a.description).toContain("even with offload")
  })
})

describe("placementIndicator", () => {
  const fit = (o: Record<string, unknown>) => ({ model: "m", ...o }) as unknown as ModelFit

  // The five host A models from flag-under-offloaded-models: two avoidably
  // offloaded must warn, three fully resident (two pinned at -ngl 40 above their
  // layer count) must not — so the check keys on the OUTCOME, never the pin.
  test("warns on avoidable offload, naming the host-resident amount", () => {
    const m2 = placementIndicator(fit({ host_resident_mb: 6037, under_offloaded: true }))
    expect(m2?.text).toContain("5.9 GB")
    expect(placementIndicator(fit({ host_resident_mb: 6166, under_offloaded: true }))).not.toBeNull()
  })
  test("silent for fully resident models, whatever the pin says", () => {
    for (const run_mode of ["gpu"]) {
      expect(placementIndicator(fit({ run_mode, host_resident_mb: 0, placement: { mode: "custom" } }))).toBeNull()
    }
    expect(placementIndicator(fit({ host_resident_mb: 0, under_offloaded: false }))).toBeNull()
  })
  test("silent for a genuine hybrid the model cannot run without", () => {
    expect(placementIndicator(fit({ host_resident_mb: 50000, under_offloaded: false, run_mode: "moe_offload" }))).toBeNull()
  })
  test("a host that predates under_offloaded falls back to run_mode + vram_required", () => {
    const avoidable = fit({ run_mode: "cpu_offload", host_resident_mb: 7165, vram_required_mb: 20000, vram_total_mb: 24560 })
    expect(placementIndicator(avoidable)).not.toBeNull()
    const needed = fit({ run_mode: "cpu_offload", host_resident_mb: 7165, vram_required_mb: 30000, vram_total_mb: 24560 })
    expect(placementIndicator(needed)).toBeNull()
  })
  test("no fit (non-llama-skein backend) renders nothing", () => {
    expect(placementIndicator(null)).toBeNull()
  })
})

describe("parseGpuLayers", () => {
  test("accepts whole numbers including 0, rejects everything else", () => {
    expect(parseGpuLayers("99")).toBe(99)
    expect(parseGpuLayers(" 0 ")).toBe(0)
    for (const bad of ["", "-1", "1.5", "all", "40 layers", "1e3"]) expect(parseGpuLayers(bad)).toBeNull()
  })
})
