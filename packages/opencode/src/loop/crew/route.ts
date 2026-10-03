// Routing a piece of work to warm capacity (crew-loop Phase 2a.1).
//
// Pure function over the peer roster and local host capacity. The decision
// order is: warm member (provider already serves the model, idle), then cloud
// member (not bound to a local host), then free host (reachable, free slot),
// otherwise leave it on the board.
//
// This is the "last branch" the design warns about: an agent that spawns when
// nothing is free feels productive and is not. "Leave it on the board" is a
// real outcome.

import type { PeerCandidate } from "../../peer/delegate"
import type { HostCapacity } from "../../local/placement"

export interface RouteInput {
  /** The model ID this work needs. */
  modelID: string
  /** Live peers (opencode-skein and claude-code sessions). */
  peers: readonly PeerCandidate[]
  /** Local host capacity (reachable hosts with free slots). */
  hosts: readonly HostCapacity[]
  /** Provider IDs that are local (LAN/loopback). */
  localProviderIDs: ReadonlySet<string>
}

export type RouteDecision =
  | { kind: "warm"; peer: PeerCandidate }
  | { kind: "cloud"; peer: PeerCandidate }
  | { kind: "free-host"; host: HostCapacity }
  | { kind: "board" }

/**
 * Decide where to route a piece of work.
 *
 * Order: warm member > cloud member > free host > board.
 * "Board" means: do not spawn; leave the item on the board for someone to
 * pick up when capacity frees.
 */
export function route(input: RouteInput): RouteDecision {
  const { modelID, peers, hosts, localProviderIDs } = input

  // Warm: a peer whose provider already serves this model and is idle.
  // "Serves the model" means the peer's provider is local and has the model
  // loaded (or is idle — an idle local host can load it without a queue).
  const warm = peers.filter((peer) => {
    if (peer.status !== "idle") return false
    if (!peer.provider) return false
    if (!localProviderIDs.has(peer.provider)) return false
    // The peer's provider is local and idle — it can serve the model.
    return true
  })
  if (warm.length > 0) {
    // Freshest warm member (most recently idle).
    warm.sort((a, b) => (b.idleForMs ?? 0) - (a.idleForMs ?? 0))
    return { kind: "warm", peer: warm[0] }
  }

  // Cloud: a peer not bound to a local host.
  const cloud = peers.filter((peer) => {
    if (peer.status !== "idle") return false
    if (peer.owner === "claude-code") return true
    if (peer.provider && !localProviderIDs.has(peer.provider)) return true
    return false
  })
  if (cloud.length > 0) {
    cloud.sort((a, b) => (b.idleForMs ?? 0) - (a.idleForMs ?? 0))
    return { kind: "cloud", peer: cloud[0] }
  }

  // Free host: a reachable local host with a free slot.
  const free = hosts.filter((h) => h.reachable && h.free > 0)
  if (free.length > 0) {
    // Most free slots first.
    free.sort((a, b) => b.free - a.free)
    return { kind: "free-host", host: free[0] }
  }

  // Nothing free: leave it on the board. Do not spawn into a queue.
  return { kind: "board" }
}

export * as CrewRoute from "./route"
