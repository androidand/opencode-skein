// The one header every peer message carries, on every transport.
//
// Claude's wire frame has no metadata slot: `message.content` is a plain
// string carrying an attribution envelope, and opencode-to-opencode delivery
// reuses that same frame (see peer/route.ts). So any coordination field that
// must survive a hop — which mode this is, which conversation it belongs to,
// which message it answers — has to be rendered INSIDE the text. Only
// same-process delivery could carry structured metadata, and a format that
// only works for one of three paths is not a format.
//
// Shape, always the first line, body after a blank line:
//
//   [peer notify id=<msgID> from=<address>]
//   [peer request id=<msgID> from=<address> context=<ctxID> deadline=15m]
//   [peer reply id=<msgID> in-reply-to=<msgID> context=<ctxID>]
//
// Deliberately unquoted. `peer/claude/codec.ts` neutralises `from="` to stop a
// crafted body forging the Claude attribution envelope's attributes; an
// unquoted `from=` here is not that pattern and passes through untouched.
//
// Everything interpolated is sanitised, because two of the values are not ours:
// the return address comes off an inbound envelope, and a session title can
// reach this via an address the sender chose. A value containing a space, a
// bracket or an equals sign could otherwise close the header early and inject
// fields that read as trusted. Parsing only ever considers the first line, so
// a body that contains a header-shaped line is inert.
//
// This module is pure and import-free apart from crypto, in the shape of
// peer/recent-ids.ts and peer/repeat-guard.ts, so it can be tested without a
// runtime and reused by every delivery path.

import { randomUUID } from "crypto"

export type PeerMode = "notify" | "request" | "reply"

export interface PeerEnvelope {
  mode: PeerMode
  /** Generated per message; also used as the transport frame's `msg_id`. */
  messageID: string
  /** The sender's return address, when it has a reachable one. */
  from?: string
  /** Groups the turns of one exchange. Created with the first request, echoed by replies. */
  contextID?: string
  /** The `messageID` this answers. Replies only. */
  inReplyTo?: string
  /** How long the sender will wait before treating a request as timed out. Requests only. */
  deadlineMinutes?: number
  /**
   * The delegated-task id, when this exchange is one. `peer/delegate.ts` still
   * correlates its pool-overflow tasks with the older `[peer-task-result <id>]`
   * marker; carrying the id here lets both be matched during migration without
   * this module having to know that marker's grammar.
   */
  taskID?: string
}

const HEADER_RE = /^\[peer (notify|request|reply)((?: [a-z-]+=[^\s\]]+)*)\]$/
const FIELD_RE = /([a-z-]+)=([^\s\]]+)/g

/** Anything that could close the header early or invent a field becomes an underscore. */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\s[\]=]/g, "_")
}

export function newMessageID(): string {
  return randomUUID()
}

/** A conversation id, visibly distinct from a message id so the two are never confused in a log. */
export function newContextID(): string {
  return `ctx-${randomUUID()}`
}

export function formatHeader(envelope: PeerEnvelope): string {
  const fields: string[] = [`id=${sanitizeHeaderValue(envelope.messageID)}`]
  if (envelope.from) fields.push(`from=${sanitizeHeaderValue(envelope.from)}`)
  if (envelope.contextID) fields.push(`context=${sanitizeHeaderValue(envelope.contextID)}`)
  if (envelope.inReplyTo) fields.push(`in-reply-to=${sanitizeHeaderValue(envelope.inReplyTo)}`)
  if (envelope.taskID) fields.push(`task=${sanitizeHeaderValue(envelope.taskID)}`)
  if (envelope.mode === "request" && envelope.deadlineMinutes !== undefined) {
    const minutes = Math.max(1, Math.round(envelope.deadlineMinutes))
    fields.push(`deadline=${minutes}m`)
  }
  return `[peer ${envelope.mode} ${fields.join(" ")}]`
}

/** Header plus body, ready to hand to a transport. A body is never altered. */
export function formatPeerEnvelope(envelope: PeerEnvelope, body: string): string {
  return `${formatHeader(envelope)}\n\n${body}`
}

export interface ParsedPeerMessage {
  envelope: PeerEnvelope
  /** The message as written, with the header and its trailing blank line removed. */
  body: string
}

/**
 * Reads the header off a message, or undefined when there is none — which is
 * the normal case for anything sent before this format existed, and for a
 * human-written message. A caller treats that as a plain notification rather
 * than rejecting it.
 */
export function parsePeerEnvelope(text: string): ParsedPeerMessage | undefined {
  const newline = text.indexOf("\n")
  const firstLine = newline === -1 ? text : text.slice(0, newline)
  const match = firstLine.match(HEADER_RE)
  if (!match) return undefined

  const mode = match[1] as PeerMode
  const envelope: PeerEnvelope = { mode, messageID: "" }
  for (const field of match[2].matchAll(FIELD_RE)) {
    const [, key, value] = field
    switch (key) {
      case "id":
        envelope.messageID = value
        break
      case "from":
        envelope.from = value
        break
      case "context":
        envelope.contextID = value
        break
      case "in-reply-to":
        envelope.inReplyTo = value
        break
      case "task":
        envelope.taskID = value
        break
      case "deadline": {
        const minutes = Number(value.replace(/m$/, ""))
        if (Number.isFinite(minutes) && minutes > 0) envelope.deadlineMinutes = minutes
        break
      }
      // An unknown field is ignored rather than fatal: a newer sender may add
      // one, and refusing the whole message over it would be worse than
      // dropping the field.
    }
  }
  // A header without an id cannot be correlated, which is the only thing a
  // header is for. Treat it as no header at all.
  if (!envelope.messageID) return undefined

  const rest = newline === -1 ? "" : text.slice(newline + 1)
  return { envelope, body: rest.startsWith("\n") ? rest.slice(1) : rest }
}

/** True when this message expects the receiver to answer. */
export function expectsReply(envelope: PeerEnvelope): boolean {
  return envelope.mode === "request"
}
