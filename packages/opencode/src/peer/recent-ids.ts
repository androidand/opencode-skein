// A bounded set of recently seen ids, for dropping duplicate inbound frames.
//
// Claude's frame `msg_id` is a real correlation id (claude-peer-protocol-spike
// findings), so the same id arriving twice — a sender retry, a reconnect
// replay — is the same message and must reach the session once. Insertion
// order is the eviction order; there is no clock, because "recent" here only
// has to outlast a retry window, not be precise.

export class RecentIDs {
  private readonly seen = new Set<string>()

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("RecentIDs capacity must be a positive integer")
  }

  /** True the first time an id is offered, false for every repeat still remembered. */
  admit(id: string): boolean {
    if (this.seen.has(id)) return false
    this.seen.add(id)
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    return true
  }

  get size(): number {
    return this.seen.size
  }
}
