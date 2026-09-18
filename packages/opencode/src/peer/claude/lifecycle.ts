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
import { RecentIDs } from "@/peer/recent-ids"
import { claudePidOf, resolveOpencodeSender } from "@/peer/route"
import { SessionStatus } from "@/session/status"
import {
  ensureSidecar,
  isManaged,
  setSidecarName,
  setSidecarStatus,
  stopAllSidecars,
  stopSidecar,
  sweepOrphanedSidecars,
  type Deliver,
} from "./sidecar-manager"

export class Service extends Context.Service<Service, {}>()("@opencode/ClaudeSidecarLifecycle") {}

/** How many inbound message ids to remember for duplicate suppression, across all sessions this process owns. */
const RECENT_INBOUND_IDS = 1_024

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    if (flags.disableClaudeCodePeerMessaging) return Service.of({})

    const events = yield* EventV2Bridge.Service
    const session = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const instanceStore = yield* InstanceStore.Service

    // Everything below runs from plain callbacks (a child process's stdout,
    // an exit handler), outside any Effect fiber. Forking on the DEFAULT
    // runtime would give those fibers Effect's default console logger — and
    // the server shares its process with the TUI, so every `Effect.log*` in
    // the injected turn would print straight over the OpenTUI frame. Fork
    // with this layer's own services instead: it was built under the app
    // runtime, so its context carries the app's file logger and log level.
    const context = yield* Effect.context<never>()
    const runFork = Effect.runForkWith(context)

    yield* Effect.promise(() => sweepOrphanedSidecars()).pipe(Effect.ignore)

    const recent = new RecentIDs(RECENT_INBOUND_IDS)

    const deliver: Deliver = (inbound) => {
      // A frame `msg_id` is a real correlation id: the same id twice is one
      // message retried or replayed, and the session must see it once.
      if (inbound.msgID && !recent.admit(`${inbound.sessionID}:${inbound.msgID}`)) return
      if (settleTaskReply(inbound.text)) return
      runFork(
        Effect.gen(function* () {
          const info = yield* session.get(SessionID.make(inbound.sessionID)).pipe(Effect.orElseSucceed(() => undefined))
          if (!info) return
          // This runs from a background event listener, not inside any
          // request's own instance context (unlike a tool call, which
          // inherits it from whatever originally invoked the session) — the
          // project instance has to be resolved explicitly from the target
          // session's own directory before anything session-scoped will work.
          const instance = yield* instanceStore.load({ directory: info.directory })
          // `fromName` and `from` are envelope attributes — display and
          // addressing only, never authorization (codec.ts). `from` is the
          // sender's return address; it is what the receiving agent has to
          // hand back to `send_peer_message` for its answer to arrive.
          const sender = yield* Effect.promise(() => resolveOpencodeSender(inbound.from))
          const pid = claudePidOf(inbound.from)
          const wrapped = sender
            ? formatPeerMessage(
                { sessionID: sender, title: inbound.fromName ?? sender, reply: { target: sender } },
                inbound.text,
              )
            : formatPeerMessage(
                {
                  harness: "claude-code",
                  sessionID: pid ?? "unknown-pid",
                  title: inbound.fromName ?? "a Claude Code peer",
                  // `resolveClaudeTarget` accepts a pid; the display name is a
                  // weaker fallback (it must be an unambiguous prefix). With
                  // neither there is nothing to address an answer to.
                  reply: pid
                    ? { target: pid }
                    : inbound.fromName
                      ? { target: inbound.fromName }
                      : { unreachable: true },
                },
                inbound.text,
              )
          yield* promptSvc
            .prompt({
              sessionID: SessionID.make(inbound.sessionID),
              agent: info.agent,
              parts: [{ type: "text", synthetic: true, text: wrapped }],
            })
            .pipe(Effect.provideService(InstanceRef, instance))
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("claude sidecar: failed to deliver inbound message", {
              "session.id": inbound.sessionID,
              msgID: inbound.msgID,
              cause,
            }),
          ),
        ),
      )
    }

    const hooksFor = (sessionID: string) => ({
      diagnostic: (message: string) => {
        runFork(Effect.logWarning("claude sidecar", { "session.id": sessionID, message }))
      },
    })

    // One sidecar per top-level session, not per subagent — a subagent
    // spawned to do one bounded task has no business being an independently
    // addressable peer, and it would mean one extra process per subagent.
    const ensureFor = (info: { id: string; directory: string; title: string; parentID?: string }) => {
      if (info.parentID) return
      ensureSidecar({ sessionID: info.id, cwd: info.directory, name: info.title }, deliver, hooksFor(info.id))
    }

    const unsubscribeCreated = yield* events.listen((event) => {
      if (event.type !== Session.Event.Created.type) return Effect.void
      const data = event.data as { info: { id: string; directory: string; title: string; parentID?: string } }
      ensureFor(data.info)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribeCreated)

    // A session's registered name is its address for every other agent on the
    // machine, and at creation time the title is still a placeholder — the
    // real one is generated after the first turn. Keep the registry current,
    // or peers can only ever see "New session - <timestamp>".
    const unsubscribeUpdated = yield* events.listen((event) => {
      if (event.type !== Session.Event.Updated.type) return Effect.void
      const data = event.data as { info: { id: string; title?: string; parentID?: string } }
      if (data.info.parentID || !data.info.title) return Effect.void
      setSidecarName(data.info.id, data.info.title)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribeUpdated)

    const unsubscribeDeleted = yield* events.listen((event) => {
      if (event.type !== Session.Event.Deleted.type) return Effect.void
      const data = event.data as { sessionID: string }
      return Effect.promise(() => stopSidecar(data.sessionID)).pipe(Effect.ignore)
    })
    yield* Effect.addFinalizer(() => unsubscribeDeleted)

    const unsubscribeStatus = yield* events.listen((event) => {
      if (event.type !== SessionStatus.Event.Status.type) return Effect.void
      const data = event.data as { sessionID: string; status: { type: string } }
      setSidecarStatus(data.sessionID, data.status.type === "idle" ? "idle" : "busy")
      // A session only ever got a sidecar if it was CREATED while a server
      // with this listener was up. Every session resumed from history — the
      // common case after a restart — was therefore unaddressable: invisible
      // to peers in other projects and unable to receive a reply. A session
      // that is doing something is exactly the one worth an address, so
      // register it the first time it reports a status.
      if (isManaged(data.sessionID)) return Effect.void
      return session.get(SessionID.make(data.sessionID)).pipe(
        Effect.flatMap((info) => Effect.sync(() => ensureFor(info))),
        Effect.ignore,
      )
    })
    yield* Effect.addFinalizer(() => unsubscribeStatus)

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
