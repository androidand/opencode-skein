// fork: detects a runaway WITHIN one stream — the model finishes (or never
// starts) and then repeats a short unit forever without emitting a stop token,
// e.g. "</parameter>\n</invoke>\n" x600. Distinct from loop-detect.ts, which
// compares completed turns, and from the sentence-level repeat guard: this one
// is periodicity at the tail of the text, whatever the characters are.

const MaxPeriod = 256
const MinRepeats = 20
const MinSpan = 400

export type Runaway = {
  /** Length of text to keep: everything up to the end of the first instance of the unit. */
  keep: number
  unit: string
  repeats: number
}

/**
 * Whether the tail of `text` is a short unit repeated many times. Cheap in the
 * common case: each candidate period is rejected at its first mismatching
 * character from the end.
 */
export function findRunaway(text: string): Runaway | undefined {
  const n = text.length
  if (n < MinSpan) return undefined
  for (let p = 1; p <= MaxPeriod && p * MinRepeats <= n; p++) {
    // how far back (from the end) the text is p-periodic
    let i = n - 1
    while (i - p >= 0 && text.charCodeAt(i) === text.charCodeAt(i - p)) i--
    const span = n - 1 - i + p // chars covered by the periodic tail
    if (span < MinSpan || Math.floor(span / p) < MinRepeats) continue
    const unit = text.slice(n - p)
    if (unit.trim().length === 0) continue
    // Whole units counted from the end, so a few characters of real text that
    // happen to match the unit's tail are not swallowed into the run.
    const repeats = Math.floor(span / p)
    return { keep: n - (repeats - 1) * p, unit, repeats }
  }
  return undefined
}

/** Synthetic user message sent after the first runaway. */
export const nudgeText =
  "Get a hold of yourself. Your last response went into a repeating loop and was cut off. Do not repeat it. Continue with the task."

export * as RunawayDetect from "./runaway-detect"
