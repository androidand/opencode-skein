/** Routing decision for the crew-loop task delegation path.

See `design.md` "Routing a piece of work" for the rule this implements:
warm member > cloud member > free host > skip.

This is a pure decision function — it does not send anything. The caller
(task.ts `delegate()`) still performs the actual send once it has the
decision.
 */

import type { PeerCandidate } from "@/peer/delegate"
import { pickPeer } from "@/peer/delegate"

export type RouteDecision =
  | { kind: "warm"; peer: PeerCandidate }
  | { kind: "cloud"; peer: PeerCandidate }
  | { kind: "free-host" }
  | { kind: "skip" }

/** Decide where a bounded piece of work should go, given the current fleet
state. Returns the highest-priority route that has a candidate.

Warm member (local host, right model, idle) beats cloud member beats free
host. If no host is reachable at all the decision falls to "skip".
 */
export function route(
  peers: PeerCandidate[],
  localProviderIDs: ReadonlySet<string>,
  model?: string,
): RouteDecision {
  // Warm: local host, idle. (Model match is checked by the caller using
  // the peer's provider + inherited modelID, since PeerCandidate does not
  // carry a model field.)
  const warm = peers.find(
    (p) =>
      p.provider !== undefined &&
      localProviderIDs.has(p.provider) &&
      p.status === "idle",
  )
  if (warm) return { kind: "warm", peer: warm }

  // Cloud: not bound to a known local host, idle. A peer with a provider
  // that is not in localProviderIDs runs on capacity the fleet does not
  // control (cloud-backed opencode or a remote host).
  const cloud = peers.find(
    (p) =>
      p.status === "idle" &&
      (p.provider === undefined || !localProviderIDs.has(p.provider)),
  )
  if (cloud) return { kind: "cloud", peer: cloud }

  // Free host: reachable local provider (any session on it is a candidate
  // slot; the actual placement will be resolved by the caller).
  const freeHost = peers.some(
    (p) =>
      p.provider !== undefined &&
      localProviderIDs.has(p.provider),
  )
  if (freeHost) return { kind: "free-host" }

  return { kind: "skip" }
}

/** Pick the best idle peer from a list, given which providers are local.
Kept for callers that need the peer directly rather than the full decision.
 */
export function pickIdlePeer(
  peers: PeerCandidate[],
  localProviderIDs: ReadonlySet<string>,
  model?: string,
): PeerCandidate | undefined {
  const decision = route(peers, localProviderIDs, model)
  if (decision.kind === "warm" || decision.kind === "cloud") return decision.peer
  return undefined
}
