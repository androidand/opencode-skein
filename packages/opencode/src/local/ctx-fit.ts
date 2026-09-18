// Deriving a context size that actually loads, when the host says the current
// one does not.
//
// A llama-skein host refuses a model whose configured context pushes its VRAM
// estimate past the card: HTTP 507, `model_does_not_fit_error` /
// `model_over_host_memory`. Retrying that request is pointless — the same
// configuration fails identically every time — so the only useful response is
// to lower the context and try again.
//
// `max_fit_ctx` is the field every other writer in this fork trusts for that
// (see the ctx-size writers in skein's sweep, the TUI dialog, and the 413
// path in provider.ts). It is also legitimately NULL exactly when it is most
// needed: a model whose KV budget at the configured context is negative has no
// computable hard ceiling, which is the shape of the failure this module
// exists for. Observed on a 24 GB card: weights 19281 MB, estimate 28949 MB at
// a configured 262144 context, `max_fit_ctx: null`. So when the trusted field
// is present it wins, and when it is absent the size is derived from the
// report's own VRAM arithmetic rather than giving up.
//
// The derivation assumes KV and compute buffers scale linearly with context,
// which is how llama.cpp's KV cache behaves and is good enough for a target
// that is then re-validated by the host on the retry.

export interface CtxFitReport {
  configured_ctx?: number | null
  max_fit_ctx?: number | null
  vram_required_mb?: number | null
  vram_total_mb?: number | null
  model_mb?: number | null
}

export interface CtxFitOptions {
  /**
   * How much of the card to plan for. A report showing 92% of VRAM is
   * described by the host as "fits with little headroom", so the default
   * leaves a slightly wider margin than the tightest thing it will accept.
   */
  usableVramFraction?: number
  /** Below this, shrinking is not worth doing; the model needs a different host. */
  minContext?: number
}

const DefaultUsableVramFraction = 0.9
const DefaultMinContext = 8192
const ContextGranularity = 1024

function positive(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Rounds down to a whole number of 1024-token blocks, matching the other ctx writers in this fork. */
export function roundDownContext(ctx: number): number {
  return Math.floor(ctx / ContextGranularity) * ContextGranularity
}

/**
 * A context size that should load on this host, or undefined when none would
 * help — the weights alone do not fit, the report is unusable, or the shortfall
 * is not context-driven. Undefined means "surface the failure", never "guess".
 */
export function contextThatFits(report: CtxFitReport, options: CtxFitOptions = {}): number | undefined {
  const fraction = options.usableVramFraction ?? DefaultUsableVramFraction
  const floor = options.minContext ?? DefaultMinContext

  // The host's own hard ceiling, when it could compute one, is always better
  // than anything derived here.
  const maxFit = positive(report.max_fit_ctx)
  if (maxFit) {
    const target = roundDownContext(maxFit)
    return target >= floor ? target : undefined
  }

  const configured = positive(report.configured_ctx)
  const required = positive(report.vram_required_mb)
  const total = positive(report.vram_total_mb)
  const weights = positive(report.model_mb)
  if (!configured || !required || !total || !weights) return undefined

  // Everything above the weights scales with context: KV cache plus compute
  // buffers. If the report does not show the configuration costing more than
  // the weights, the shortfall is not the context's doing and shrinking it
  // would be a guess.
  const scalesWithContext = required - weights
  if (scalesWithContext <= 0) return undefined

  const budget = total * fraction - weights
  // The weights alone overrun the card. No context makes that fit.
  if (budget <= 0) return undefined

  const target = roundDownContext(configured * (budget / scalesWithContext))
  if (target < floor) return undefined
  // Nothing to gain from a "shrink" that is not smaller.
  if (target >= configured) return undefined
  return target
}
