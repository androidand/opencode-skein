import { Effect, Schema, Scope } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { sendClaudeMessage } from "@/peer/claude/client"
import { resolveClaudeTarget } from "@/peer/claude/resolve"
import { settleTaskReply } from "@/peer/delegate"
import { deliverToOpencodeSession, foreignRegistration, foreignRoster } from "@/peer/route"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { formatPeerMessage, resolveMessageTargets, resolveTarget } from "@/session/peers"
import type { TaskPromptOps } from "./task"
import DESCRIPTION from "./send-peer-message.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  target: Schema.String.annotate({
    description: "Session id, or an unambiguous prefix of the target session's title.",
  }),
  message: Schema.String.annotate({
    description: "The message text to deliver. Keep it short — point to files, commits, or specs rather than pasting large context.",
  }),
})

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
  matches?: string[]
  sessionID?: string
  accepted?: boolean
  harness?: "claude-code"
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
        params: { target: string; message: string },
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

          const [sessions, statuses, permissions, foreign] = yield* Effect.all([
            session.list(),
            status.list(),
            permission.list(),
            Effect.promise(() => foreignRoster()),
          ])

          const peers = resolveMessageTargets({
            sessions: foreign.merge(sessions.map((item) => ({
              id: item.id,
              parentID: item.parentID,
              directory: item.directory,
              title: item.title,
              agent: item.agent,
              model: item.model ? { providerID: item.model.providerID, id: item.model.id } : undefined,
              updatedAt: item.time.updated,
            }))),
            statuses,
            pendingPermission: new Set(permissions.map((item) => item.sessionID)),
            loops: [],
            callerID: ctx.sessionID,
            foreign: foreign.statuses,
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
                  `No opencode-skein or Claude Code session anywhere on this machine matches "${params.target}" ` +
                  "(idle sessions are valid targets here, unlike the `peers` tool's awareness roster — but your " +
                  "own session and any subagent you spawned are excluded either way).",
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
            const claudeResult = yield* Effect.promise(() =>
              sendClaudeMessage({
                targetPid: claudeResolved.record.pid,
                fromSessionID: ctx.sessionID,
                fromName: caller?.title ?? ctx.sessionID,
                // A tool call only happens while the calling session is
                // actively generating — "idle" was never true here.
                fromMode: "prompting",
                text: message,
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
              metadata: { sessionID: claudeResolved.record.sessionId, accepted: true, harness: "claude-code" },
              output:
                `Delivered to Claude Code session pid ${claudeResolved.record.pid} ` +
                `("${claudeResolved.record.name ?? "unnamed"}"). This channel is outbound-only right now — ` +
                "the Claude session cannot reply back through it.",
            }
          }
          const peer = resolved.peer

          // A literally in-flight turn (actively generating right now) must not
          // be joined or raced — the same foreign-turn hazard `loop.ts` guards
          // against. `awaiting-permission` / `stalled` / `cancelling` are not
          // mid-generation and are safe to prompt into.
          if (peer.status === "busy") {
            return {
              title: "Peer is busy",
              metadata: { reason: "busy", sessionID: peer.sessionID },
              output: `Peer session ${peer.sessionID} ("${peer.title}") is mid-turn right now. Not delivered — retry once it is idle or awaiting permission.`,
            }
          }

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

          if (settleTaskReply(message)) {
            return {
              title: `Task result delivered to ${peer.title}`,
              metadata: { sessionID: peer.sessionID, accepted: true },
              output: `Delivered as the result of the task ${peer.title} delegated to you.`,
            }
          }

          const text = formatPeerMessage(
            { sessionID: ctx.sessionID, title: caller?.title ?? "(unknown session)" },
            message,
          )

          // A session this process owns is prompted here, fire-and-forget (its
          // turn is not this tool call's concern). A session another opencode
          // process owns is reached over that process's sidecar socket — the
          // only way its own TUI sees the message and runs the turn.
          const outcome = yield* deliverToOpencodeSession({
            targetSessionID: peer.sessionID,
            fromSessionID: ctx.sessionID,
            fromName: caller?.title ?? ctx.sessionID,
            text: message,
            local: () =>
              ops
                .prompt({
                  sessionID: targetSessionID,
                  agent: target?.agent ?? ctx.agent,
                  parts: [{ type: "text", synthetic: true, text }],
                })
                .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true })),
          })
          if (outcome.via === "socket" && !outcome.result.ok) {
            return {
              title: "Peer unreachable",
              metadata: { reason: outcome.result.reason === "not-found" ? "unreachable" : outcome.result.reason, sessionID: peer.sessionID },
              output: `Peer session ${peer.sessionID} ("${peer.title}") is owned by another opencode process that did not accept the message: ${outcome.result.reason}${outcome.result.detail ? ` (${outcome.result.detail})` : ""}.`,
            }
          }

          return {
            title: `Message sent to ${peer.title}`,
            metadata: { sessionID: peer.sessionID, accepted: true },
            output: `Accepted for delivery to peer session ${peer.sessionID} ("${peer.title}")${outcome.via === "socket" ? " via its owner process" : ""}.`,
          }
        }),
    }
  }),
)
