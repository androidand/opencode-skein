// Why a peer tool needs a repeat guard at all.
//
// `send_peer_message` is fire-and-forget: it returns "accepted for delivery",
// which is an acknowledgement and not the answer the model asked for. A model
// that sent a question and got back something that is not an answer has every
// reason to try again, and nothing stopped it. Observed live, 2026-09-18: a
// session sent the same one-line question to four peers in a loop, several
// hundred times, until it exhausted its context — then compacted, read its own
// goal back out of the summary, and resumed the loop. A not-found result made
// it worse by naming a recovery step ("use the peers tool to find the exact
// id"), which reads as an invitation to retry.
//
// This is not rate limiting for its own sake, and it is not silent dropping.
// Its whole purpose is that the SECOND identical attempt returns something the
// model can act on — "this already happened, here is what to do instead" —
// rather than the same result that produced the first attempt.

export class RepeatGuard {
  private readonly seen = new Map<string, number[]>()

  constructor(
    private readonly windowMs: number,
    private readonly capacity = 512,
  ) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("RepeatGuard windowMs must be positive")
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("RepeatGuard capacity must be a positive integer")
  }

  /**
   * Records one attempt and returns how many identical ones already happened
   * inside the window. Zero means this is the first, so the caller proceeds
   * normally; anything higher is a repeat the caller should answer differently.
   */
  record(key: string, now = Date.now()): number {
    const cutoff = now - this.windowMs
    const previous = (this.seen.get(key) ?? []).filter((at) => at > cutoff)
    previous.push(now)
    // Re-inserting moves the key to the end, so the eviction below drops the
    // least recently touched key rather than an arbitrary one.
    this.seen.delete(key)
    this.seen.set(key, previous)
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    return previous.length - 1
  }

  get size(): number {
    return this.seen.size
  }
}
