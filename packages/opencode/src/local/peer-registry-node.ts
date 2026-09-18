// Starts the persistent mDNS/LAN peer registry (see ./mdns.ts) once at server
// boot. Mirrors LocalProviderSync's node shape (a discardable one-shot effect
// run at startup), but instead of a bounded scan-then-write-config job, this
// starts a background process that keeps running for the server's lifetime —
// startPeerRegistry() itself owns the Bonjour browser + refresh timers, and is
// idempotent, so re-running this layer (e.g. in tests) is harmless.
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { startPeerRegistry } from "./mdns"

export const layer = Layer.effectDiscard(Effect.sync(() => startPeerRegistry()))

export const node = LayerNode.make({
  name: "@opencode/PeerRegistry",
  layer,
  deps: [],
})

export * as PeerRegistry from "./peer-registry-node"
