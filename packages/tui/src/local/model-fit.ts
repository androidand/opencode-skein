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

/**
 * One-line placement summary for the ctx dialog: where the weights live and,
 * when automatic offload is off for this model, why. null when there is
 * nothing worth saying (plain full-GPU, or fit unknown).
 */
export function describePlacement(fit: ModelFit | null | undefined): string | null {
  if (!fit) return null
  const hostMb = fit.host_resident_mb ?? 0
  if (hostMb > 0) {
    const where = `weights ${fmtGB(fit.gpu_resident_mb ?? 0)} GB GPU + ${fmtGB(hostMb)} GB RAM`
    return fit.placement?.perf_class === "cpu-bound-hybrid" || fit.placement?.perf_class === "cpu-only"
      ? `${where} (offloaded, slow)`
      : `${where} (offloaded)`
  }
  // `custom` = the command pins -ngl/--n-cpu-moe/-ot/...: llama-skein will not
  // offload by itself, so ctx past the VRAM ceiling is simply unreachable.
  if (fit.placement?.mode === "custom") return "offload pinned off (--n-gpu-layers etc. in command)"
  return null
}

export type PlacementAction = {
  /** "unpin" is actionable; "info" explains why nothing can be done. */
  kind: "unpin" | "info"
  title: string
  description: string
}

const RELOAD_NOTE = "reloads the model and drops its loaded state"

/**
 * What the ctx dialog should offer for a model's offload, from the fit report
 * alone — the client never plans placement. Only a model whose command pins
 * placement flags (`placement.mode == "custom"`) has anything to offer: an
 * unpinned one is already placed by llama-skein.
 *
 * Asks "could this load with offload?", not "is it slow?": `if_unpinned` is the
 * server's own counterfactual plan, so a refuse is reported as "won't load even
 * with offload" rather than implying the pin is the problem.
 */
export function placementAction(fit: ModelFit | null | undefined): PlacementAction | null {
  if (!fit || fit.placement?.mode !== "custom") return null
  const alt = fit.placement.if_unpinned
  if (!alt) return null
  if (alt.loadable === false) {
    return {
      kind: "info",
      title: "Offload would not help",
      description: "won't load even with offload — weights exceed VRAM plus safe host RAM",
    }
  }
  if (alt.mode === "gpu") {
    return {
      kind: "unpin",
      title: "Remove the placement pin",
      description: `fits fully on the GPU without it, and llama-skein re-plans if that ever stops being true · ${RELOAD_NOTE}`,
    }
  }
  const host = alt.est_host_mb ?? 0
  const slow = alt.perf_class === "cpu-bound-hybrid" || alt.perf_class === "cpu-only"
  return {
    kind: "unpin",
    title: "Allow offload to RAM",
    description: `loads with ~${fmtGB(host)} GB of weights in RAM${slow ? " (slow, host-bandwidth bound)" : ""} · ${RELOAD_NOTE}`,
  }
}

export type PlacementIndicator = { text: string }

/**
 * The sidebar's avoidable-offload indicator. Prefers the host's own
 * `under_offloaded`; for a host that predates it, falls back to the mechanical
 * pair derivable from /api/fit (cpu_offload while the GPU share would have
 * fit). It must stay silent for a model that genuinely needs host RAM and for
 * a fully resident one — a warning on a correct hybrid teaches people to
 * ignore it. Names the host-resident amount so the cost is legible.
 */
export function placementIndicator(fit: ModelFit | null | undefined): PlacementIndicator | null {
  if (!fit) return null
  const hostMb = fit.host_resident_mb ?? 0
  if (hostMb <= 0) return null
  const avoidable =
    fit.under_offloaded !== undefined
      ? fit.under_offloaded === true
      : fit.run_mode === "cpu_offload" &&
        (fit.vram_required_mb ?? Infinity) <= (fit.vram_total_mb ?? 0)
  if (!avoidable) return null
  return { text: `⚠ ${fmtGB(hostMb)} GB of weights in RAM — avoidable` }
}

/** Parses an operator-typed GPU layer count. null = not a usable value. */
export function parseGpuLayers(input: string): number | null {
  const t = input.trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return Number.isSafeInteger(n) ? n : null
}

export type CtxRow = {
  value: number
  title: string
  description: string | undefined
  category: string
  highlight: boolean
}

/**
 * The context-size rows of the per-model dialog, as a pure function of what the
 * host reported — so what the operator is shown can be tested against real
 * payloads instead of being assumed.
 *
 * Nothing here computes a limit: `maxPhysical` is llama-skein's figure and is
 * only displayed and annotated, never replaced or second-guessed. Rows above it
 * are annotated, never hidden or blocked (the estimate has been wrong in both
 * directions).
 */
export function buildCtxRows(input: {
  current: number
  recommended: number | null
  maxPhysical: number
  mem: MemSnapshot | null
}): CtxRow[] {
  const { current: cur, recommended: rec, maxPhysical: physMax, mem: m } = input
  const kvPerToken = m && cur > 0 && m.kvEstMb > 0 ? m.kvEstMb / cur : null
  const extra = new Set(cur > 0 ? [cur] : [])
  if (rec) extra.add(rec)
  if (physMax > 0) extra.add(physMax)
  const sizes = [...new Set([...PRESETS, ...extra])].sort((a, b) => a - b)
  return sizes.map((n) => {
    let description: string | undefined
    if (aboveCeiling(n, physMax)) {
      description = `⚠ above estimated ceiling (${fmtCtxK(physMax)}) — may not load`
      if (n === cur) description = `current · ${description}`
    } else if (n === cur && n === rec) {
      description = "current · recommended"
    } else if (n === cur) {
      description = "current"
    } else if (n === rec) {
      description = "recommended for this model + VRAM"
    } else if (n === physMax) {
      description = "physical max — no safety margin, expect ~100% VRAM"
    } else if (n < MIN_WORKFLOW_CTX) {
      description = "⚠ too small — MCP tools fill this before meaningful work"
    } else if (n > cur && m && kvPerToken) {
      const extraKvMb = (n - cur) * kvPerToken
      description = `+${fmtCtxK(n - cur)}`
      if (extraKvMb > m.freeMb) {
        description += ` · ⚠ exceeds free ${m.label} (${fmtGB(m.freeMb)} GB)`
      }
    }
    return { value: n, title: fmtCtxK(n), description, category: "Context", highlight: n === cur || n === rec || n === physMax }
  })
}
