/**
 * Live contract check: opencode's view of a real llama-skein host.
 *
 *   LLAMA_SKEIN_LIVE_URLS=http://host-a:11435,http://host-b:8080 \
 *     bun test test/live/fit-contract.live.ts
 *
 * Not part of the default suite (the file name does not match bun's test
 * pattern, so it only runs when named). It FAILS, rather than skips, when no
 * URL is given or a host has no loaded model: a live suite that passes by
 * finding nothing to check is the failure it exists to prevent.
 *
 * It asserts what opencode may rely on, with no assumption left implicit:
 *  - every field the client reads exists with the right type;
 *  - the client's memory view equals the host's own numbers (no arithmetic drift);
 *  - the ceilings are internally consistent;
 *  - what the dialog shows is exactly the host's figure, and the client's own
 *    recommendation never exceeds a ceiling the host reported.
 * Whether the host's figures match REAL VRAM is llama-skein's `fitcheck`
 * (go run ./cmd/fitcheck), because only a host-side tool can measure that.
 */
import { describe, expect, test } from "bun:test"
import { createClient, createConfig } from "../../src/local/llama-skein/gen/client"
import { LlamaSkeinClient } from "../../src/local/llama-skein/gen/sdk.gen"
import { buildCtxRows, computeRecommendedCtx, extractMem, normalizeBaseURL } from "../../src/local/model-fit"

const urls = (process.env["LLAMA_SKEIN_LIVE_URLS"] ?? "").split(",").map((u) => u.trim()).filter(Boolean)

describe("live llama-skein contract", () => {
  test("at least one host is configured", () => {
    expect(urls.length).toBeGreaterThan(0)
  })

  for (const url of urls) {
    test(url, async () => {
      const client = new LlamaSkeinClient({ client: createClient(createConfig({ baseUrl: normalizeBaseURL(url) })) })
      const hw = (await client.getHardware()).data
      expect(hw, "hardware").toBeDefined()
      const model = hw!.loaded_model?.id
      expect(model, `no model is loaded on ${url}; load one so there is something to check`).toBeTruthy()
      const fit = (await client.getModelFit({ model: model! })).data
      expect(fit, "fit").toBeDefined()
      const f = fit!

      // 1. Fields the client reads, present and typed.
      for (const k of ["configured_ctx", "max_safe_ctx", "max_physical_ctx", "model_mb", "vram_required_mb", "vram_total_mb"] as const) {
        expect(typeof f[k], k).toBe("number")
        expect(Number.isFinite(f[k] as number), k).toBe(true)
      }
      expect(f.configured_ctx!).toBeGreaterThan(0)

      // 2. The client's memory view is the host's, unmodified.
      const mem = extractMem(hw!)
      expect(mem).not.toBeNull()
      expect(mem!.totalMb).toBe(hw!.vram!.total_mb!)
      expect(mem!.usedMb).toBe(hw!.vram!.used_mb!)
      expect(mem!.freeMb).toBe(hw!.vram!.free_mb!)
      expect(f.vram_total_mb).toBe(hw!.vram!.total_mb!)

      // 3. The ceilings are consistent with each other.
      expect(f.max_physical_ctx!, "a loaded model cannot be above its own physical ceiling").toBeGreaterThanOrEqual(f.configured_ctx!)
      if (f.max_fit_ctx) expect(f.max_fit_ctx).toBeLessThanOrEqual(f.max_physical_ctx!)
      if (f.fit_level !== "no") expect(f.vram_required_mb!).toBeLessThanOrEqual(f.vram_total_mb!)

      // 4. The dialog shows the host's figure, and only rows above it are flagged.
      const ceiling = f.max_physical_ctx!
      const rows = buildCtxRows({ current: f.configured_ctx!, recommended: null, maxPhysical: ceiling, mem })
      expect(rows.some((r) => r.value === ceiling), "the ceiling is a row").toBe(true)
      for (const r of rows) {
        const flagged = r.description?.includes("above estimated ceiling") ?? false
        expect(flagged, `row ${r.value}`).toBe(r.value > ceiling)
      }

      // 5. The client's own recommendation respects every ceiling the host gave.
      const rec = computeRecommendedCtx(mem!, f.configured_ctx!, f.max_fit_ctx)
      if (rec !== null) {
        expect(rec).toBeLessThanOrEqual(ceiling)
        if (f.max_fit_ctx) expect(rec).toBeLessThanOrEqual(f.max_fit_ctx)
      }
    }, 30_000)
  }
})
