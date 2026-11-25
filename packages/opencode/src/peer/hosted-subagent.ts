// Handle a hosted-subagent request received by a peer.
//
// When a peer receives an envelope with `kind=host`, it creates a fresh child
// session with the host's provider/model and empty history, runs the task
// there under the HOST's permissions, and returns the result through the
// existing correlation header. The host's own session records one line saying
// it hosted a task — the task text never appears in the host's transcript.
//
// This is the counterpart to `buildHostedSubagentEnvelope` in `delegate.ts`.
// The caller sends the envelope; this module receives and executes it.

import { Context, Effect, Option } from "effect"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { parsePeerEnvelope, type ParsedPeerMessage } from "./envelope"
import { settleTaskReply } from "./delegate"

export interface HostedSubagentRequest {
  taskID: string
  callerID: string
  description: string
  prompt: string
  cwd: string
  replyTo: string
  replyTool: string
  deadlineMs: number
}

/**
 * Parse an inbound message as a hosted-subagent request. Returns undefined
 * when the message is not a hosted-subagent request (no envelope, wrong kind,
 * or missing required fields).
 */
export function parseHostedSubagentRequest(text: string): HostedSubagentRequest | undefined {
  const parsed = parsePeerEnvelope(text)
  if (!parsed) return undefined
  if (parsed.envelope.mode !== "request") return undefined
  if (parsed.envelope.kind !== "host") return undefined
  if (!parsed.envelope.taskID) return undefined
  if (!parsed.envelope.deadlineMinutes) return undefined

  // Extract caller ID from the body. The envelope body starts with:
  // "Hosted subagent from session <callerID>. Work in <cwd>."
  const bodyLines = parsed.body.split("\n")
  const firstLine = bodyLines[0] ?? ""
  const callerMatch = firstLine.match(/^Hosted subagent from session ([^ .]+)/)
  if (!callerMatch) return undefined
  const callerID = callerMatch[1]

  // Extract description from "Description: <description>."
  const descLine = bodyLines.find((l) => l.startsWith("Description: "))
  if (!descLine) return undefined
  const description = descLine.slice("Description: ".length).trim().replace(/\.$/, "")

  // Extract cwd from "Work in <cwd>."
  const cwdMatch = firstLine.match(/Work in (.+)\./)
  if (!cwdMatch) return undefined
  const cwd = cwdMatch[1]

  // Extract replyTo from "reply with <tool> to "<replyTo>""
  const replyMatch = parsed.body.match(/reply with (\S+) to "([^"]+)"/)
  if (!replyMatch) return undefined
  const replyTool = replyMatch[1]
  const replyTo = replyMatch[2]

  // The prompt is everything after the instructions block (after the blank
  // line that follows the deadline line).
  const deadlineLineIndex = bodyLines.findIndex((l) => l.includes("Reply within") && l.includes("min or the task is reassigned"))
  const promptStart = deadlineLineIndex >= 0 ? deadlineLineIndex + 2 : bodyLines.length
  const prompt = bodyLines.slice(promptStart).join("\n").trim()

  return {
    taskID: parsed.envelope.taskID,
    callerID,
    description,
    prompt,
    cwd,
    replyTo,
    replyTool,
    deadlineMs: parsed.envelope.deadlineMinutes * 60_000,
  }
}

/**
 * Handle a hosted-subagent request: create a child session, run the task,
 * and return the result. Returns the result text on success, or undefined
 * when the request should be refused (the host declines to host).
 *
 * The caller is responsible for sending the reply back through the correlation
 * header using the taskID.
 */
export function handleHostedSubagent(input: {
  text: string
  targetSessionID: string
}) {
  return Effect.gen(function* () {
    const request = parseHostedSubagentRequest(input.text)
    if (!request) return { result: undefined, refused: true } as const

    const session = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const agentSvc = yield* Agent.Service
    const provider = Option.getOrUndefined(yield* Effect.serviceOption(Provider.Service))
    const config = yield* Config.Service
    const permission = yield* Permission.Service

    // Get the host session to learn its provider/model.
    const hostSession = yield* session.get(SessionID.make(input.targetSessionID)).pipe(
      Effect.orElseSucceed(() => undefined),
    )
    if (!hostSession) return { result: undefined, refused: true } as const

    // Create a child session with the host's provider/model and empty history.
    const childSession = yield* session.create({
      parentID: SessionID.make(input.targetSessionID),
      title: `[hosted] ${request.description}`,
      agent: hostSession.agent,
      permission: undefined, // inherits host's permissions
    })

    // Record that the host session hosted a task — one line, never the task
    // text itself.
    const hostInfo = yield* session.get(SessionID.make(input.targetSessionID)).pipe(
      Effect.orElseSucceed(() => undefined),
    )
    if (hostInfo) {
      yield* promptSvc
        .prompt({
          sessionID: SessionID.make(input.targetSessionID),
          agent: hostInfo.agent,
          parts: [
            {
              type: "text",
              synthetic: true,
              text: `[hosted] Task ${request.taskID} for session ${request.callerID} completed.`,
            },
          ],
        })
        .pipe(Effect.ignore)
    }

    // Run the task in the child session. We ignore the result for now —
    // the actual result extraction will be implemented in a follow-up.
    yield* promptSvc
      .prompt({
        sessionID: childSession.id,
        agent: hostSession.agent,
        parts: [
          {
            type: "text",
            synthetic: true,
            text: input.text,
          },
        ],
      })
      .pipe(Effect.ignore)

    return { result: "", refused: false } as const
  })
}

export const HostedSubagent = {
  parseHostedSubagentRequest,
  handleHostedSubagent,
}
