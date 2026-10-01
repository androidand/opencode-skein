// A bounded delivery-state machine for one peer conversation.
//
// The spec requires that a sender see delivery advance through a fixed sequence
// and that a terminal state never flip back to a good one. This module is that
// requirement as pure logic: it owns the state of one conversation and refuses
// any transition the sequence does not allow, so the failure mode the spec was
// written to prevent — a late reply resurrecting a timed-out request, or two
// "replied" states for one exchange — cannot happen regardless of who calls it.
//
// Pure and import-free, so it can be unit-tested with no runtime and reused by
// every delivery path (send_peer_message, the Claude sidecar, the delegate
// registry). The transports stay in peer/envelope.ts and peer/delegate.ts;
// this one owns only the state the sender is told.

export type PeerDeliveryState =
  | "accepted"
  | "acknowledged"
  | "working"
  | "replied"
  | "failed"
  | "timed out"
  | "unreachable"

const TERMINAL: ReadonlySet<PeerDeliveryState> = new Set([
  "replied",
  "failed",
  "timed out",
  "unreachable",
])

/** The ordered set a live conversation moves through before it settles. */
const REACHABLE: Record<PeerDeliveryState, ReadonlySet<PeerDeliveryState>> = {
  accepted: new Set(["acknowledged", "working", "replied", "failed", "unreachable"]),
  acknowledged: new Set(["working", "replied", "failed", "unreachable"]),
  working: new Set(["replied", "failed", "timed out", "unreachable"]),
  replied: new Set(),
  failed: new Set(),
  "timed out": new Set(),
  unreachable: new Set(),
}

export interface StateTransition {
  from: PeerDeliveryState
  to: PeerDeliveryState
}

export class InvalidTransition extends Error {
  readonly from: PeerDeliveryState
  readonly to: PeerDeliveryState
  constructor(from: PeerDeliveryState, to: PeerDeliveryState) {
    super(`peer delivery state cannot move from "${from}" to "${to}"`)
    this.name = "InvalidTransition"
    this.from = from
    this.to = to
  }
}

/**
 * Track the single delivery state of one conversation. `acknowledged` and
 * `working` are observable signals only; the sender must not treat either as
 * proof that the peer understood or completed anything — only `replied` settles
 * the exchange, and only once.
 */
export class PeerDelivery {
  private state: PeerDeliveryState = "accepted"
  private readonly history: StateTransition[] = []

  get currentState(): PeerDeliveryState {
    return this.state
  }

  get isTerminal(): boolean {
    return TERMINAL.has(this.state)
  }

  /** Every transition recorded so far, oldest first — the audit trail. */
  get transitions(): StateTransition[] {
    return this.history.map((t) => ({ from: t.from, to: t.to }))
  }

  /**
   * Advance the state. A transition into or out of a terminal state is
   * refused, so a late reply, a stray ack after the deadline, or a reconnected
   * sidecar cannot flip a settled conversation back to a good state.
   */
  transition(to: PeerDeliveryState): void {
    if (TERMINAL.has(this.state) || this.state === to) {
      if (TERMINAL.has(this.state)) {
        throw new InvalidTransition(this.state, to)
      }
      return
    }
    if (!REACHABLE[this.state].has(to)) {
      throw new InvalidTransition(this.state, to)
    }
    this.history.push({ from: this.state, to })
    this.state = to
  }

  /**
   * True when this state sequence shows the peer at least acknowledged the
   * request. Acknowledged and working are signals, never proof of completion,
   * so this is deliberately weaker than settled().
   */
  get acknowledged(): boolean {
    return this.state !== "accepted"
  }

  /** True once the conversation has settled in any state. */
  get settled(): boolean {
    return this.isTerminal
  }
}

export const PeerDeliveryMachine = {
  PeerDelivery,
  InvalidTransition,
}
