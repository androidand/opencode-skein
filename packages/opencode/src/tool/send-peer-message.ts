import { Effect, Schema, Scope } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { sendClaudeMessage } from "@/peer/claude/client"
import { resolveClaudeTarget } from "@/peer/claude/resolve"
import { settleTaskReply } from "@/peer/delegate"
import { formatPeerEnvelope, newMessageID, peerBody, type PeerMode } from "@/peer/envelope"
import { PeerInbox } from "@/peer/inbox"
import { RepeatGuard } from "@/peer/repeat-guard"
import {
  deliverToOpencodeSession,
  foreignRegistration,
  foreignRoster,
  liveSessionIDs,
  returnAddressFor,
} from "@/peer/route"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { formatPeerMessage, resolveMessageTargets, resolveTarget } from "@/session/peers"
import type { TaskPromptOps } from "./task"
import DESCRIPTION from "./send-peer-message.txt"
import * as Tool from "./tool"

/**
 * How the receiver should treat this message. `request` expects an answer and
 * carries a correlation header so a reply lines up with it; `notify` is
 * fire-and-forget context with no reply obligation. The default keeps anything
 * that never set the parameter behaving exactly as before — a plain notify.
 */
export type PeerSendMode = "notify" | "request"

const ModeParameter = Schema.optional(Schema.Literals(["notify", "request"])).annotate({
  description:
    'How the target should treat this message. "request" expects an answer and carries a correlation id so a reply lines up; "notify" is fire-and-forget. Defaults to "notify".',
})

export const Parameters = Schema.Struct({
   target: Schema.String.annotate({
     description: "Session id, or an unambiguous prefix of the target session's title.",
   }),
   message: Schema.String.annotate({
     description:
       "The message text to deliver. Keep it short — point to files, commits, or specs rather than pasting large context.",
   }),
   mode: ModeParameter,
 })

/** How many recent sessions machine-wide to consider for fuzzy matching. */
const MachineRosterLimit = 200

// A model that asks a question through a fire-and-forget tool gets back an
// acknowledgement, not an answer, and its natural next move is to ask again.
// These two guards make the second attempt say something different from the
// first, which is the only thing that ends the loop. See `peer/repeat-guard.ts`
// for the incident that motivated them.
const DuplicateSendWindowMs = 90_000
const UnresolvedTargetWindowMs = 180_000
const duplicateSends = new RepeatGuard(DuplicateSendWindowMs)
const unresolvedTargets = new RepeatGuard(UnresolvedTargetWindowMs)

const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/

/**
 * Resolves the caller's requested mode and, for a request, produces the
 * correlation envelope the header carries. A notify (the default, and the
 * value for anything sent before the parameter existed) carries no id and no
 * reply expectation. The id is generated once here and reused as the transport
 * frame's `msg_id` so the two never diverge.
 */
function resolveSendMode(mode: PeerSendMode | undefined): { mode: PeerSendMode; messageID: string | undefined } {
  if (mode === "request") return { mode: "request", messageID: newMessageID() }
  return { mode: "notify", messageID: undefined }
}

/** The fields the peer roster projection needs; `list` and `listGlobal` both supply them. */
type RosterSession = {
  id: string
  parentID?: string
  directory: string
  title: string
  agent?: string
  model?: { providerID: string; id: string }
  time: { updated: number }
}

interface ResultMetadata {
  reason?:
    | "ambiguous"
    | "not-found"
    | "busy"
    | "unreachable"
    | "protocol-mismatch"
    | "identity-mismatch"
    | "no-token"
    | "messaging-disabled"
    | "unaddressable"
    | "duplicate"
  matches?: string[]
   sessionID?: string
   accepted?: boolean
   messageID?: string
   harness?: "claude-code"
   /** Held for a busy target this process owns; not injected yet. See `peer/inbox.ts`. */
   queued?: boolean
 }

export const SendPeerMessageTool = Tool.define(
  "send_peer_message",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const status = yield* SessionStatus.Service
    const permission = yield* Permission.Service
    const flags = yield* RuntimeFlags.Service
    const scope = yield* Scope.Scope

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: { target: string; message: string; mode?: PeerSendMode },
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<ResultMetadata>> =>
        Effect.gen(function* () {
          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          // Missing promptOps is a wiring defect (session/tools.ts always
          // supplies it), not a normal failure mode a caller can act on — a
          // defect keeps this tool's error channel `never`, matching
          // Tool.Def's execute signature (same die-not-fail shape as other
          // invariant checks in this codebase).
          if (!ops) return yield* Effect.die(new Error("send_peer_message requires promptOps in ctx.extra"))

           const message = params.message.trim()
           if (message === "")
             return { title: "No message sent", metadata: {}, output: "Message text is empty — nothing sent." }

           // Mode drives everything below: a request carries a correlation
           // header and returns its id so a reply can be traced back; a notify
           // is the default and changes nothing about what is sent. The header
           // rides inside the text because both transports reuse the plain
           // message frame with no metadata slot, so a header that only survived
           // one path would not be a header at all.
           const { mode: sendMode, messageID } = resolveSendMode(params.mode)
           const envelope = sendMode === "request" && messageID
             ? { mode: sendMode as PeerMode, messageID }
             : undefined
           const deliveredText = envelope
             ? formatPeerEnvelope(envelope, message)
             : message

          // A peer can be working in any repo on this machine, and this tool
          // says so — but `session.list()` only ever returned the CALLER's
          // project, and the sidecar roster only covers sessions some OTHER
          // process registered. A sibling session in another project of this
          // same process fell through both and was reported "not found" while
          // sitting in the next tab. List globally instead. `own` is kept
          // separately because it is what decides whether this process may
          // prompt the target itself.
          const requested = params.target.trim()
          const [own, everywhere, statuses, permissions, foreign, live] = yield* Effect.all([
            session.list(),
            session.listGlobal({ limit: MachineRosterLimit }),
            status.list(),
            permission.list(),
            Effect.promise(() => foreignRoster()),
            Effect.promise(() => liveSessionIDs()),
          ])
          const ownIDs = new Set<string>(own.map((item) => item.id))
          const byID = new Map<string, RosterSession>()
          for (const item of [...everywhere, ...own]) byID.set(item.id, item)
          // The global roster is bounded by recency, so an exact id naming a
          // real but older session would otherwise be reported as no such
          // session — a lie about something that exists. `session.get` is not
          // project-scoped, so look that one up directly.
          if (!byID.has(requested) && SESSION_ID_RE.test(requested)) {
            const direct = yield* session.get(SessionID.make(requested)).pipe(Effect.orElseSucceed(() => undefined))
            if (direct) byID.set(direct.id, direct)
          }
          const sessions = [...byID.values()]

          const peers = resolveMessageTargets({
            sessions: foreign.merge(
              sessions.map((item) => ({
                id: item.id,
                parentID: item.parentID,
                directory: item.directory,
                title: item.title,
                agent: item.agent,
                model: item.model ? { providerID: item.model.providerID, id: item.model.id } : undefined,
                updatedAt: item.time.updated,
              })),
            ),
            statuses,
            pendingPermission: new Set(permissions.map((item) => item.sessionID)),
            loops: [],
            callerID: ctx.sessionID,
            foreign: foreign.statuses,
            live,
            now: Date.now(),
          })

          const resolved = resolveTarget(peers, params.target)
          if (!resolved.ok) {
            if (resolved.reason === "ambiguous") {
              return {
                title: "Ambiguous target",
                metadata: { reason: "ambiguous", matches: resolved.matches.map((p) => p.sessionID) },
                output:
                  `"${params.target}" matches more than one active peer session: ` +
                  resolved.matches.map((p) => `${p.sessionID} ("${p.title}")`).join(", ") +
                  ". Use the exact session id.",
              }
            }
            // Not an opencode-skein peer — try a live Claude Code session.
            const claudeResolved = yield* Effect.promise(() =>
              resolveClaudeTarget(params.target, { enabled: !flags.disableClaudeCodePeerSource }),
            )
            if (!claudeResolved.ok) {
              if (claudeResolved.reason === "ambiguous") {
                return {
                  title: "Ambiguous target",
                  metadata: { reason: "ambiguous", matches: claudeResolved.matches.map((r) => String(r.pid)) },
                  output:
                    `"${params.target}" matches more than one live Claude Code session: ` +
                    claudeResolved.matches.map((r) => `${r.pid} ("${r.name ?? "unnamed"}")`).join(", ") +
                    ". Use the exact pid or Claude session id.",
                }
              }
              return {
                title: "Peer not found",
                metadata: { reason: "not-found" },
                output:
                  (unresolvedTargets.record(`${ctx.sessionID}|${params.target}`) > 0
                    ? `"${params.target}" still does not exist — you already tried to reach it. Stop trying this ` +
                      "target: retrying will not make it appear, and calling `peers` again will return the same " +
                      "roster. Use a target from that roster, or carry on without this peer and say in your reply " +
                      "that it could not be reached. "
                    : "") +
                  `No opencode-skein or Claude Code session matches "${params.target}". Searched: every session ` +
                  `updated recently on this machine (any project), any session addressed by its exact id, and ` +
                  "live Claude Code sessions. Idle sessions are valid targets here, unlike the `peers` tool's " +
                  "awareness roster; your own session and any subagent you spawned are excluded either way.",
              }
            }
            if (flags.disableClaudeCodePeerMessaging) {
              return {
                title: "Claude peer messaging disabled",
                metadata: { reason: "messaging-disabled", harness: "claude-code" },
                output:
                  `Found Claude Code session pid ${claudeResolved.record.pid} ` +
                  `("${claudeResolved.record.name ?? "unnamed"}"), but Claude Code peer messaging is disabled on ` +
                  "this instance (OPENCODE_DISABLE_CLAUDE_CODE_PEER_MESSAGING is set). Not delivered.",
              }
            }

            const caller = yield* session.get(ctx.sessionID).pipe(Effect.orElseSucceed(() => undefined))
            // Claude's reply rule is "send to `from`", so `from` has to be this
            // session's real sidecar socket for an answer to ever arrive.
            const returnAddress = returnAddressFor(ctx.sessionID)
            const claudeResult = yield* Effect.promise(() =>
              sendClaudeMessage({
                targetPid: claudeResolved.record.pid,
                fromSessionID: ctx.sessionID,
                fromAddress: returnAddress.address,
                 fromName: caller?.title ?? ctx.sessionID,
                 // A tool call only happens while the calling session is
                 // actively generating — "idle" was never true here.
                 fromMode: "prompting",
                 text: deliveredText,
               }),
            )
            if (!claudeResult.ok) {
              return {
                title: "Claude peer message failed",
                metadata: { reason: claudeResult.reason, harness: "claude-code" },
                output: `Not delivered to Claude Code session pid ${claudeResolved.record.pid}: ${claudeResult.reason}${claudeResult.detail ? ` (${claudeResult.detail})` : ""}.`,
              }
            }
             return {
               title: `Message sent to Claude Code session ${claudeResolved.record.pid}`,
               metadata: {
                 sessionID: claudeResolved.record.sessionId,
                 accepted: true,
                 messageID,
                 harness: "claude-code",
               },
              output:
                `Accepted for delivery to Claude Code session pid ${claudeResolved.record.pid} ` +
                `("${claudeResolved.record.name ?? "unnamed"}"). Accepted means the frames reached its socket, not ` +
                "that it has read or acted on them. " +
                (returnAddress.reachable
                  ? "It can reply: an answer arrives in this session as a peer message, so if you asked a question, " +
                    "carry on with other work rather than polling."
                  : "This session has no live inbox of its own right now, so it cannot receive a reply — treat this " +
                    "as a one-way notification."),
            }
          }
          const peer = resolved.peer
          const targetSessionID = SessionID.make(peer.sessionID)
          const [caller, target, registration] = yield* Effect.all([
            session.get(ctx.sessionID).pipe(Effect.orElseSucceed(() => undefined)),
            session.get(targetSessionID).pipe(Effect.orElseSucceed(() => undefined)),
            Effect.promise(() => foreignRegistration(peer.sessionID)),
          ])
          // A session in another project is invisible to this process's
          // store; its registration is what says it exists.
          if (!target && !registration) {
            return {
              title: "Peer disappeared",
              metadata: { reason: "unreachable", sessionID: peer.sessionID },
              output: `Peer session ${peer.sessionID} was found a moment ago but is gone now. Not delivered.`,
            }
          }

           // settleTaskReply matches the older `[peer-task-result <id>]` marker
           // anchored at the START of the text; once a request carries a header
           // that anchor no longer matches and every delegated task would time
            // out silently, so strip the header first. See peerBody's contract.
            if (settleTaskReply(peerBody(message))) {
              return {
                title: `Task result delivered to ${peer.title}`,
                metadata: { sessionID: peer.sessionID, accepted: true },
                output: `Delivered as the result of the task ${peer.title} delegated to you.`,
              }
            }

           // The same text to the same peer twice in quick succession is a model
          // waiting for an answer that this tool never returns. Tell it that
          // rather than delivering the same message again.
          const repeats = duplicateSends.record(`${ctx.sessionID}|${peer.sessionID}|${message}`)
          if (repeats > 0) {
            return {
              title: "Already sent — not sent again",
              metadata: { reason: "duplicate", sessionID: peer.sessionID },
              output:
                `You already sent this exact message to ${peer.sessionID} ("${peer.title}") moments ago, and it was ` +
                "accepted. It has not been sent again. An answer never arrives as the result of this call — if the " +
                "peer replies, it reaches you later as a new message that starts a new turn. Do not resend and do " +
                "not poll. Continue with other work now, and if you need an answer before you can continue, say so " +
                "to your own user instead of asking the peer again.",
            }
          }

           const text = formatPeerMessage(
             {
               sessionID: ctx.sessionID,
               title: caller?.title ?? "(unknown session)",
               mode: sendMode,
               reply: { target: ctx.sessionID },
             },
             message,
           )

          // A literally in-flight turn (actively generating right now) must not
          // be joined or raced — the same foreign-turn hazard `loop.ts` guards
          // against — but a refusal here used to be the end of the story:
          // nothing then delivered the message once the turn ended, and a
          // turn running tens of minutes made that an indefinite, silent gap
          // in both directions. For a target THIS process owns, the fix is to
          // hold the delivery and let `SessionStatus.set`'s idle transition
          // run it — the exact moment everything else already calls safe.
          // `awaiting-permission` / `stalled` / `cancelling` were never
          // gated here; only the raw status matters for this decision.
          const owned = ownIDs.has(peer.sessionID)
          const freshStatus = owned ? yield* status.get(targetSessionID) : undefined
          const isBusy = freshStatus?.type === "busy" || freshStatus?.type === "retry"

          const runLocal = () =>
            ops
              .prompt({
                sessionID: targetSessionID,
                agent: target?.agent ?? ctx.agent,
                parts: [{ type: "text", synthetic: true, text }],
              })
              .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))

          if (owned && isBusy) {
            PeerInbox.enqueue(peer.sessionID, () => runLocal().pipe(Effect.asVoid))
            return {
              title: `Queued for ${peer.title}`,
              metadata: { sessionID: peer.sessionID, accepted: true, messageID, queued: true },
              output:
                `Peer session ${peer.sessionID} ("${peer.title}") is mid-turn right now. Held, not delivered yet — ` +
                "it will be injected automatically the moment that turn ends. You do not need to retry, and there " +
                "is nothing to poll: continue with other work now.",
            }
          }

          // A session this process owns is prompted here, fire-and-forget (its
          // turn is not this tool call's concern). A session another opencode
          // process owns is reached over that process's sidecar socket — the
          // only way its own TUI sees the message and runs the turn. A foreign
          // target's busy status is a mirrored snapshot, not live, so it is not
          // gated here at all: the owning process's own inbound path decides,
          // with the same real-time information this branch just used.
          const outcome = yield* deliverToOpencodeSession({
            targetSessionID: peer.sessionID,
            fromSessionID: ctx.sessionID,
            fromName: caller?.title ?? ctx.sessionID,
            text: deliveredText,
            owned,
            local: runLocal,
          })
          if (outcome.via === "unaddressable") {
            return {
              title: "Peer has no live address",
              metadata: { reason: "unaddressable", sessionID: peer.sessionID },
              output:
                `Peer session ${peer.sessionID} ("${peer.title}") exists, but it is driven by another opencode ` +
                "process and has not registered an address, so there is no safe way to deliver to it — prompting " +
                "it from here would run its turn in the wrong process. It registers one as soon as it next does " +
                "something; retry then, or reach whoever is at that session another way.",
            }
          }
          if (outcome.via === "socket" && !outcome.result.ok) {
            return {
              title: "Peer unreachable",
              metadata: {
                reason: outcome.result.reason === "not-found" ? "unreachable" : outcome.result.reason,
                sessionID: peer.sessionID,
              },
              output: `Peer session ${peer.sessionID} ("${peer.title}") is owned by another opencode process that did not accept the message: ${outcome.result.reason}${outcome.result.detail ? ` (${outcome.result.detail})` : ""}.`,
            }
          }

           return {
             title: `Message sent to ${peer.title}`,
             metadata: { sessionID: peer.sessionID, accepted: true, messageID },
             output:
               `Accepted for delivery to peer session ${peer.sessionID} ("${peer.title}")` +
              `${outcome.via === "socket" ? " via its owner process" : ""}. ` +
              (peer.reachable
                ? "A process is attending that session, so it picks the message up on its next turn."
                : "No process is attending that session — its turn will run here, but nobody is watching it, so " +
                  "do not wait on an answer."),
          }
        }),
    }
  }),
)
