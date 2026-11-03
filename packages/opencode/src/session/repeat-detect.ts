// Detects a repetition pattern that forms WITHIN a single LLM stream: the model
// emits the same sentence (or an alternating pair of sentences) over and over
// as text deltas. Different from SessionLoopDetect, which compares completed
// responses across turns. Exact fragment matching only — fuzzy similarity is
// deliberately avoided so benign near-repeats in prose are not cut.

export type RepeatKind = "same-fragment" | "paired-fragments"

export type RepeatFire = {
  kind: RepeatKind
  fragment: string
  repeats: number
}

export class TextRepeatDetector {
  private static readonly delimiter = /[.!?\r\n]/
  // Wait-style fragments ("I'll wait for the notification.") are short; normal
  // prose sentences are longer. 12 keeps short code lines / list items
  // from qualifying.
  static readonly minLength = 12
  private static readonly sameStreak = 3
  private static readonly pairedLength = 6
  // Bound the unpunctuated remainder so pathological non-prose output (minified
  // JSON, base64) cannot grow the buffer indefinitely.
  private static readonly pendingLimit = 8192

  #pending = ""
  #window: string[] = []
  #fired = false

  feed(delta: string): RepeatFire | undefined {
    if (this.#fired) return undefined
    this.#pending += delta
    if (this.#pending.length > TextRepeatDetector.pendingLimit) {
      this.#pending = this.#pending.slice(-TextRepeatDetector.pendingLimit)
    }
    let offset = 0
    while (true) {
      const match = this.#pending.slice(offset).match(TextRepeatDetector.delimiter)
      if (!match || match.index === undefined) break
      this.#push(this.#pending.slice(offset, offset + match.index))
      offset += match.index + 1
    }
    this.#pending = this.#pending.slice(offset)
    return this.#fire
  }

  get #fire(): RepeatFire | undefined {
    const w = this.#window
    if (w.length >= TextRepeatDetector.sameStreak) {
      const [a, b, c] = w.slice(-3)
      if (a === b && b === c) return this.#detected("same-fragment", c, TextRepeatDetector.sameStreak)
    }
    if (w.length >= TextRepeatDetector.pairedLength) {
      const last = w.slice(-TextRepeatDetector.pairedLength)
      if (
        last[0] === last[2] &&
        last[2] === last[4] &&
        last[1] === last[3] &&
        last[3] === last[5] &&
        last[0] !== last[1]
      ) {
        return this.#detected("paired-fragments", `${last[0]} / ${last[1]}`, TextRepeatDetector.pairedLength)
      }
    }
    return undefined
  }

  #detected(kind: RepeatKind, fragment: string, repeats: number): RepeatFire {
    this.#fired = true
    return { kind, fragment: fragment.length > 80 ? fragment.slice(0, 80) + "…" : fragment, repeats }
  }

  #push(raw: string) {
    const value = normalizeFragment(raw)
    // Empty units arrive from repeated sentence terminators ("A.\n" leaves an
    // empty tail and the next delta starts with whitespace) — skip them
    // silently, they are safe and resetting the window here would defeat
    // detection of the exact pattern this detector exists for.
    if (!value) return
    if (!qualifiesFragment(value)) {
      // Anything that could be real new content resets the window; a stale
      // match must never linger long enough to become a false positive.
      this.#window = []
      return
    }
    this.#window.push(value)
    if (this.#window.length > TextRepeatDetector.pairedLength) {
      this.#window = this.#window.slice(-TextRepeatDetector.pairedLength)
    }
  }
}

function normalizeFragment(raw: string) {
  return raw.trim().toLowerCase().replace(/\s+/g, " ")
}

function qualifiesFragment(value: string) {
  return value.length >= TextRepeatDetector.minLength && /[a-z]/.test(value) && value.includes(" ")
}

export * as SessionRepeatDetect from "./repeat-detect"
