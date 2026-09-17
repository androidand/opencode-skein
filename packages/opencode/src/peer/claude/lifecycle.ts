// Wires the sidecar manager to real session lifecycle: a session gets a
// sidecar when it starts, loses it when it ends, and an inbound message the
// sidecar receives is injected into that real session via
// `SessionPrompt.Service`, the same primitive `send_peer_message` uses.
// On by default. Entirely inert when `disableClaudeCodePeerMessaging` is
// set — no sidecar is ever spawned, no session event is even inspected.
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"
import { formatPeerMessage } from "@/session/peers"
import { settleTaskReply } from "@/peer/delegate"
import { ensureSidecar, stopAllSidecars, stopSidecar, sweepOrphanedSidecars } from "./sidecar-manager"

export class Service extends Context.Service<Service, {}>()("@opencode/ClaudeSidecarLifecycle") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    if (flags.disableClaudeCodePeerMessaging) return Service.of({})

    const events = yield* EventV2Bridge.Service
    const session = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const instanceStore = yield* InstanceStore.Service

    yield* Effect.promise(() => sweepOrphanedSidecars()).pipe(Effect.ignore)

    const deliver = (sessionID: string, text: string, fromName?: string) => {
      if (settleTaskReply(text)) return
      Effect.gen(function* () {
        const info = yield* session.get(SessionID.make(sessionID)).pipe(Effect.orElseSucceed(() => undefined))
        if (!info) return
        // This runs from a background event listener, not inside any
        // request's own instance context (unlike a tool call, which
        // inherits it from whatever originally invoked the session) — the
        // project instance has to be resolved explicitly from the target
        // session's own directory before anything session-scoped will work.
        const instance = yield* instanceStore.load({ directory: info.directory })
        // `fromName` is the envelope's self-reported sender name — display
        // only, per findings.md's own security note (never authorization),
        // but still worth surfacing so a multi-peer setup can tell which
        // Claude session actually sent this.
        const wrapped = formatPeerMessage({ sessionID: "claude-code", title: fromName ?? "a Claude Code peer" }, text)
        yield* promptSvc
          .prompt({
            sessionID: SessionID.make(sessionID),
            agent: info.agent,
            parts: [{ type: "text", synthetic: true, text: wrapped }],
          })
          .pipe(Effect.provideService(InstanceRef, instance))
      }).pipe(
        Effect.catchCause((cause) => Effect.logError("claude sidecar: failed to deliver inbound message", { cause })),
        Effect.runFork,
      )
    }

    const unsubscribeCreated = yield* events.listen((event) => {
      if (event.type !== Session.Event.Created.type) return Effect.void
      const data = event.data as { info: { id: string; directory: string; title: string; parentID?: string } }
      // One sidecar per top-level session, not per subagent — a subagent
      // spawned to do one bounded task has no business being an
      // independently addressable Claude Code peer, and it would mean one
      // extra process per subagent.
      if (data.info.parentID) return Effect.void
      ensureSidecar({ sessionID: data.info.id, cwd: data.info.directory, name: data.info.title }, deliver)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribeCreated)

    const unsubscribeDeleted = yield* events.listen((event) => {
      if (event.type !== Session.Event.Deleted.type) return Effect.void
      const data = event.data as { sessionID: string }
      return Effect.promise(() => stopSidecar(data.sessionID)).pipe(Effect.ignore)
    })
    yield* Effect.addFinalizer(() => unsubscribeDeleted)

    // A normal server stop must not leave live sidecar processes and their
    // registrations behind — this is the graceful counterpart to
    // `sweepOrphanedSidecars`'s crash recovery, not a replacement for it.
    yield* Effect.addFinalizer(() => Effect.promise(() => stopAllSidecars()).pipe(Effect.ignore))

    return Service.of({})
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [EventV2Bridge.node, Session.node, SessionPrompt.node, RuntimeFlags.node, InstanceStore.node],
})

// No standalone `defaultLayer` composition: `InstanceStore` is a "global
// node" (see project/instance-store.ts) that isn't meant to be resolved
// outside the full app graph `node` above already joins. Nothing constructs
// this layer standalone today; if that changes, provide `InstanceStore` the
// same way `app-runtime.ts`/`server.ts` do rather than reinventing it here.

export * as ClaudeSidecarLifecycle from "./lifecycle"
