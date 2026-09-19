import type { FitLevel, FitReport, ModelFit, ResourceSnapshot } from "./llama-skein/gen/types.gen"

/**
 * Model-fit engine: turn a local backend's hardware snapshot into a safe
 * context-window size. Shared by the ctx-size dialog and (future) the
 * auto-adjust-on-overflow recovery path so there is one source of truth for
 * "what context fits this hardware".
 */

export const MIN_WORKFLOW_CTX = 65536
export const MAX_CTX = 262144

export type MemSnapshot = {
  freeMb: number
  totalMb: number
  usedMb: number
  label: string
  modelMb: number // model weights (from file size); 0 if unknown
  kvEstMb: number // kv cache estimate; 0 if unknown
}

/**
 * Recommended ctx_size from real hardware data.
 *
 * `kvEstMb` is the KV cache pre-allocated for the *current* ctx_size, so
 * `currentCtx` must be the backend's **hard n_ctx** (`/api/fit` `configured_ctx`)
 * — not `max_safe_ctx`, which is a prompt budget with the output reserve already
 * subtracted and skews the ratio. `freeMb` is genuinely-available VRAM (already
 * excludes driver/OS overhead). The KV budget is what's allocated now plus what's
 * free to expand into, scaled linearly by current ctx, rounded to 4k, and clamped
 * to the workflow range. Returns null when there isn't enough signal to compute.
 *
 * `maxFitCtx` is llama-skein's `/api/fit` `max_fit_ctx`: the largest hard n_ctx
 * that fits this host's VRAM. It is a hard ceiling — without it this returned
 * ~250k for a model with lots of free VRAM. 0/undefined means "ceiling unknown",
 * in which case nothing is capped.
 */
export function computeRecommendedCtx(m: MemSnapshot, currentCtx: number, maxFitCtx?: number): number | null {
  if (m.kvEstMb <= 0 || currentCtx <= 0) return null
  const kvBudgetMb = m.kvEstMb + m.freeMb
  const tokens = Math.floor((kvBudgetMb * currentCtx) / m.kvEstMb)
  const rounded = Math.floor(tokens / 4096) * 4096
  const clamped = Math.max(MIN_WORKFLOW_CTX, Math.min(MAX_CTX, rounded))
  if (!maxFitCtx || maxFitCtx <= 0) return clamped
  // The ceiling outranks MIN_WORKFLOW_CTX: on a 32k-trained model the workflow
  // floor is simply unreachable, and recommending 64k there writes a --ctx-size
  // the backend cannot load.
  return Math.min(clamped, maxFitCtx)
}

/**
 * True when a ctx_size is above what the model can actually load on this host.
 *
 * Takes the *physical* ceiling (`/api/fit` `max_physical_ctx` — no
 * vramSafetyFrac/promptMarginFrac margin, the true OOM line), not the
 * conservative `max_fit_ctx` recommendation. Blocking on the conservative
 * number is what made this dialog recommend a value and then refuse that
 * same value: the two were computed with different amounts of safety margin,
 * so a value the dialog itself suggested could read as "above ceiling" a
 * moment later. Blocking on the true physical ceiling means "recommended"
 * and "will this be refused" can never disagree.
 *
 * 0/undefined means the ceiling is unknown (non-llama-skein backend, VRAM
 * unreadable, or an older llama-skein without this field) — never block on
 * missing data.
 */
export function aboveCeiling(ctx: number, maxPhysicalCtx?: number): boolean {
  return !!maxPhysicalCtx && maxPhysicalCtx > 0 && ctx > maxPhysicalCtx
}

export const PRESETS = [
  4096, 8192, 12288, 16384, 20480, 24576, 28672, 32768, 36864, 40960, 49152, 57344, 65536, 73728, 81920, 98304, 114688,
  131072, 163840, 196608, 262144, 393216, 524288, 786432, 1048576,
]

export function fmtCtxK(n: number): string {
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}k`
  if (n >= 1000) return `${Math.round(n / 1024)}k`
  return `${n}`
}

export function fmtGB(mb: number): string {
  return (mb / 1024).toFixed(1)
}

export function normalizeBaseURL(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "")
}

// ── per-model fit verdicts, for the model picker ──────────────────────────
//
// `/api/fit` reports one verdict per configured model, keyed by id
// (`ModelFit.model`). A model absent from the report — or no report at all —
// carries no verdict, which every helper below treats as "we don't know",
// never as "it doesn't fit": a missing signal must degrade to the unannotated,
// fully-usable list a report-less dialog already showed before fit data
// existed, not to a false negative that hides a real, loadable model.

function findFit(report: FitReport | undefined, modelID: string): ModelFit | undefined {
  return report?.models.find((entry) => entry.model === modelID)
}

const FIT_LEVEL_LABEL: Record<FitLevel, string> = {
  perfect: "Perfect fit",
  good: "Good fit",
  tight: "Tight fit",
  marginal: "Marginal fit",
  no: "Does not fit",
  unknown: "Fit unknown",
}

/** The verdict's label, whatever it is — including "Fit unknown". Undefined only when there is no verdict at all. */
export function fmtFitLevel(report: FitReport | undefined, modelID: string): string | undefined {
  const fit = findFit(report, modelID)
  return fit ? FIT_LEVEL_LABEL[fit.fit_level] : undefined
}

/** True only for an explicit "no" verdict. Never fabricated from a missing report or a missing entry. */
export function fitIsNo(report: FitReport | undefined, modelID: string): boolean {
  return findFit(report, modelID)?.fit_level === "no"
}

/** False only when the verdict is explicitly "no". No data — no report, or no entry for this model — reads as safe. */
export function fitIsLoadable(report: FitReport | undefined, modelID: string): boolean {
  return !fitIsNo(report, modelID)
}

/**
 * True when there is no usable verdict for this model: no report at all, no
 * entry for it, or an explicit "unknown" (VRAM could not be read). All three
 * are the same case from the UI's point of view — nothing to show.
 */
export function fitIsUnknown(report: FitReport | undefined, modelID: string): boolean {
  const fit = findFit(report, modelID)
  return !fit || fit.fit_level === "unknown"
}

/** The label to show next to a model, or undefined when there is no verdict worth showing (no data, or "unknown"). */
export function fitLabel(report: FitReport | undefined, modelID: string): string | undefined {
  if (fitIsUnknown(report, modelID)) return undefined
  return fmtFitLevel(report, modelID)
}

/**
 * The model to pre-select when a fit report is available: the largest
 * loadable model by resident weight size, tie-broken by higher measured
 * throughput and then by id — a deterministic order so the same report
 * always recommends the same model. `sizeFor` supplies a size when the fit
 * report didn't measure `model_mb` (an older backend, or a model that hasn't
 * been probed with weights loaded yet); it is never a substitute for a real
 * "no" or "unknown" verdict, both of which exclude a model outright.
 *
 * No report at all is "no data to recommend from", not "recommend nothing is
 * wrong" — returns undefined rather than guessing.
 */
export function recommendedModelID(report: FitReport | undefined, sizeFor: (modelID: string) => number): string | undefined {
  if (!report) return undefined
  const candidates = report.models.filter((entry) => entry.fit_level !== "no" && entry.fit_level !== "unknown")
  if (candidates.length === 0) return undefined

  const sizeOf = (entry: ModelFit) => (entry.model_mb && entry.model_mb > 0 ? entry.model_mb : sizeFor(entry.model))

  let best = candidates[0]
  let bestSize = sizeOf(best)
  for (const entry of candidates.slice(1)) {
    const size = sizeOf(entry)
    const better =
      size > bestSize ||
      (size === bestSize &&
        ((entry.est_tokens_per_sec ?? 0) > (best.est_tokens_per_sec ?? 0) ||
          ((entry.est_tokens_per_sec ?? 0) === (best.est_tokens_per_sec ?? 0) && entry.model < best.model)))
    if (better) {
      best = entry
      bestSize = size
    }
  }
  return best.model
}

/** Map a llama-skein hardware snapshot to the memory view used for fitting. */
export function extractMem(hw: ResourceSnapshot): MemSnapshot | null {
  const modelMb = hw.loaded_model?.model_mb ?? 0
  const kvEstMb = hw.loaded_model?.kv_estimate_mb ?? 0

  if (hw.vram?.total_mb && hw.vram.total_mb > 100) {
    return {
      freeMb: hw.vram.free_mb ?? 0,
      usedMb: hw.vram.used_mb ?? 0,
      totalMb: hw.vram.total_mb,
      label: "VRAM",
      modelMb,
      kvEstMb,
    }
  }
  if (hw.memory?.total_mb) {
    return {
      freeMb: hw.memory.free_mb ?? 0,
      usedMb: hw.memory.used_mb ?? 0,
      totalMb: hw.memory.total_mb,
      label: hw.memory.type === "unified" ? "Unified" : "RAM",
      modelMb,
      kvEstMb,
    }
  }
  return null
}
