// Wires the sidecar manager to real session lifecycle: a session gets a
// sidecar when it starts, loses it when it ends, and an inbound message the
// sidecar receives is injected into that real session via
// `SessionPrompt.Service`, the same primitive `send_peer_message` uses.
// On by default. Entirely inert when `disableClaudeCodePeerMessaging` is
// set — no sidecar is ever spawned, no session event is even inspected.
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"
import { formatPeerMessage } from "@/session/peers"
import { settleTaskReply } from "@/peer/delegate"
import { settlePeerReply } from "@/peer/envelope"
import { parseHostedSubagentRequest } from "@/peer/hosted-subagent"
import { PeerInbox } from "@/peer/inbox"
import { Loop } from "@/loop/loop"
import { leadVerdictFor } from "@/peer/lead-runtime"
import { RecentIDs } from "@/peer/recent-ids"
import { deliverToLoop } from "./loop-route"
import { claudePidOf, deliverToOpencodeSession, resolveOpencodeSender } from "@/peer/route"
import { sendClaudeMessage } from "@/peer/claude/client"
import { SessionStatus } from "@/session/status"
import {
  ensureSidecar,
  isManaged,
  setSidecarName,
  setSidecarStatus,
  sidecarDirectoryFor,
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
    const sessionStatus = yield* SessionStatus.Service
    const config = yield* Config.Service
    const loop = yield* Loop.Service

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
      // The task id rides in the reply's structured envelope header, so the
      // correlation reads the header, not a marker anchored at the start of the
      // body. Pass the raw text so the header (and its task id) is not stripped.
      if (settleTaskReply(inbound.text)) return
      // Structured envelope replies carry `in-reply-to` so a sender can await
      // a synchronous answer. Match against pending requests before injecting
      // the message as a prompt. Falls through to prompt injection when there
      // is no pending request — the reply is still delivered as context.
      if (settlePeerReply(inbound.text)) return
      // This runs from a background event listener, not inside any request's
      // own instance context (unlike a tool call, which inherits one from
      // whatever originally invoked the session) — an `InstanceRef` has to be
      // established explicitly before any session-scoped service will work
      // (`SessionStatus.get` and `SessionPrompt.prompt` need one;
      // `Session.get` itself reads the global DB). The directory therefore
      // cannot come from a session-scoped lookup — `ensureSidecar` was given
      // the directory at registration time and the sidecar manager still has
      // it; read it from there instead. `inbound.sessionID` is the sidecar's
      // own owner ID, not sender-controlled text, so resolving/booting the
      // instance before the `info` existence check below cannot be triggered
      // by a remote peer.
      const directory = sidecarDirectoryFor(inbound.sessionID)
      if (!directory) {
        runFork(
          Effect.logWarning("claude sidecar: dropping inbound for unmanaged session", {
            "session.id": inbound.sessionID,
            msgID: inbound.msgID,
          }),
        )
        return
      }
      // Hosted-subagent requests (`kind=host`) are handled specially: the host
      // creates a fresh child session with its own provider/model and runs the
      // task there under the host's permissions. The host's own session records
      // one line; the task text never appears in the host's transcript.
      const hosted = parseHostedSubagentRequest(inbound.text)
      if (hosted) {
        runFork(
          instanceStore
            .provide(
              { directory },
              Effect.gen(function* () {
                const hostSession = yield* session.get(SessionID.make(inbound.sessionID)).pipe(
                  Effect.orElseSucceed(() => undefined),
                )
                if (!hostSession) {
                  yield* Effect.logWarning("hosted subagent: host session not found", {
                    "session.id": inbound.sessionID,
                    taskID: hosted.taskID,
                  })
                  return
                }
                // Create a child session and run the task there.
                const childSession = yield* session.create({
                  parentID: SessionID.make(inbound.sessionID),
                  title: `[hosted] ${hosted.description}`,
                  agent: hostSession.agent,
                })
                yield* promptSvc
                  .prompt({
                    sessionID: childSession.id,
                    agent: hostSession.agent,
                    parts: [{ type: "text", synthetic: true, text: inbound.text }],
                  })
                  .pipe(Effect.ignore)
                // Record one line in the host's session that a task was hosted.
                yield* promptSvc
                  .prompt({
                    sessionID: SessionID.make(inbound.sessionID),
                    agent: hostSession.agent,
                    parts: [
                      {
                        type: "text",
                        synthetic: true,
                        text: `[hosted] Task ${hosted.taskID} for session ${hosted.callerID} completed.`,
                      },
                    ],
                  })
                  .pipe(Effect.ignore)
                // Send the result back through the correlation header. The
                // caller is waiting on a reply with `task=<taskID>`.
                const replyText = `[peer reply task=${hosted.taskID}]\n\nTask completed in child session ${childSession.id}.`
                const replyEnvelope = formatPeerMessage(
                  { sessionID: inbound.sessionID, title: "hosted-subagent", reply: { target: hosted.replyTo } },
                  replyText,
                )
                // Send reply using the same transport the caller used.
                if (hosted.replyTool === "SendMessage") {
                  const sent = yield* Effect.promise(() =>
                    sendClaudeMessage({
                      targetPid: Number(hosted.replyTo),
                      fromSessionID: inbound.sessionID,
                      fromName: "hosted-subagent",
                      fromMode: "prompting",
                      text: replyEnvelope,
                    }),
                  )
                  if (!sent.ok) {
                    yield* Effect.logWarning("hosted subagent: reply send failed", {
                      taskID: hosted.taskID,
                      reason: sent.reason,
                    })
                  }
                } else {
                  const target = yield* session.get(SessionID.make(hosted.replyTo)).pipe(
                    Effect.orElseSucceed(() => undefined),
                  )
                  const deliveryOutcome = yield* deliverToOpencodeSession({
                    targetSessionID: hosted.replyTo,
                    fromSessionID: inbound.sessionID,
                    fromName: "hosted-subagent",
                    text: replyEnvelope,
                    owned: true,
                    local: () =>
                      promptSvc
                        .prompt({
                          sessionID: SessionID.make(hosted.replyTo),
                          agent: target?.agent ?? hostSession.agent,
                          parts: [{ type: "text", synthetic: true, text: replyEnvelope }],
                        })
                        .pipe(Effect.asVoid),
                  })
                  if (deliveryOutcome.via === "socket" && !deliveryOutcome.result.ok) {
                    yield* Effect.logWarning("hosted subagent: reply send failed", {
                      taskID: hosted.taskID,
                      reason: deliveryOutcome.result.reason,
                    })
                  }
                }
              }),
            )
            .pipe(Effect.catchCause((cause) =>
              Effect.logError("hosted subagent: failed to handle request", {
                "session.id": inbound.sessionID,
                msgID: inbound.msgID,
                cause,
              }),
            )),
        )
        return
      }
      runFork(
        instanceStore
          .provide(
            { directory },
            Effect.gen(function* () {
              // When the target session runs a crew loop, route peer messages
              // into the loop's inbox so they are surfaced in the next
              // iteration rather than injected as a raw prompt into the
              // session turn.
              // A loop that has finished no longer takes messages; fall
              // through to prompt injection so the idle session still gets it.
              if (yield* deliverToLoop(loop, inbound)) return
              const info = yield* session.get(SessionID.make(inbound.sessionID)).pipe(Effect.orElseSucceed(() => undefined))
              if (!info) {
                yield* Effect.logWarning("claude sidecar: dropping inbound for unknown session", {
                  "session.id": inbound.sessionID,
                  msgID: inbound.msgID,
                })
                return
              }
              // `fromName` and `from` are envelope attributes — display and
              // addressing only, never authorization (codec.ts). `from` is the
              // sender's return address; it is what the receiving agent has to
              // hand back to `send_peer_message` for its answer to arrive.
              const sender = yield* Effect.promise(() => resolveOpencodeSender(inbound.from))
              const pid = claudePidOf(inbound.from)
              // Whether this sender is the user's designated lead. Decided from the
              // authenticated sender (the socket the frame arrived on, resolved above),
              // never from the text. Off unless this session's user opted in.
              const cfg = yield* config.get().pipe(Effect.orElseSucceed(() => undefined))
              const verdict = leadVerdictFor(
                sender
                  ? { harness: "opencode-skein", sessionID: sender }
                  : { harness: "claude-code", pid: pid ? Number(pid) : undefined, address: inbound.from },
                cfg?.experimental?.follow_lead === true,
              )
              const lead = verdict.granted ? verdict : undefined
              if (lead) {
                yield* Effect.logInfo("claude sidecar: inbound from the granted lead", {
                  "session.id": inbound.sessionID,
                  grant: lead.grantID,
                })
              }
              const wrapped = sender
                ? formatPeerMessage(
                    { sessionID: sender, title: inbound.fromName ?? sender, reply: { target: sender }, lead },
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
                      lead,
                    },
                    inbound.text,
                  )
              const targetID = SessionID.make(inbound.sessionID)
              // `instanceStore.provide` only wraps this generator's own
              // computation, not a closure called later from outside it
              // (`PeerInbox.enqueue` runs `inject` from a *different* fiber,
              // once the target goes idle) — `inject` re-provides InstanceRef
              // itself so it works from either call site.
              const inject = () =>
                instanceStore.provide(
                  { directory },
                  promptSvc
                    .prompt({
                      sessionID: targetID,
                      agent: info.agent,
                      parts: [{ type: "text", synthetic: true, text: wrapped }],
                    })
                    .pipe(Effect.asVoid),
                )

              // Every inbound message — from a real Claude Code peer, or from
              // another opencode process reached over the same socket — lands
              // here regardless of who sent it. A target mid-turn cannot be
              // injected into safely, so hold it and let `SessionStatus.set`'s
              // idle transition run it: the same signal `send_peer_message`'s
              // owned-target path now waits on, so both directions of "someone
              // tried to reach a busy session" resolve the same way instead of
              // one silently discarding the message and the other queueing it.
              const currentStatus = yield* sessionStatus.get(targetID)
              if (currentStatus.type === "busy" || currentStatus.type === "retry") {
                PeerInbox.enqueue(inbound.sessionID, inject)
                return
              }
              yield* inject()
            }),
          )
          .pipe(
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
      // Safe without an explicit `InstanceRef`: `Session.get` reads the
      // global DB directly (no `InstanceState.context`), and `ensureFor`
      // only spawns a sidecar — no session-scoped service is touched.
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
  deps: [Config.node, EventV2Bridge.node, Session.node, SessionPrompt.node, RuntimeFlags.node, InstanceStore.node, SessionStatus.node, Loop.node],
})

// No standalone `defaultLayer` composition: `InstanceStore` is a "global
// node" (see project/instance-store.ts) that isn't meant to be resolved
// outside the full app graph `node` above already joins. Nothing constructs
// this layer standalone today; if that changes, provide `InstanceStore` the
// same way `app-runtime.ts`/`server.ts` do rather than reinventing it here.

export * as ClaudeSidecarLifecycle from "./lifecycle"
