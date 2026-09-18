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

// Values are percent-encoded rather than scrubbed. An earlier version replaced
// every unsafe character with an underscore, which is safe but LOSSY — and the
// most important value here is a return address. `uds:/tmp/cc socks/1.sock` and
// `uds:/tmp/cc-socks/1.sock` both collapsed to the same string, so a reply
// could be sent to a different real peer, or to nothing, with no error
// anywhere. Reversible encoding keeps the address the sender actually meant.
//
// `%` is encoded first so the mapping stays injective, and anything outside
// printable ASCII goes too: NUL, ESC, NEL, zero-width and bidi-override
// characters cannot break the grammar, but they can forge what a human or a
// terminal sees, and this text is rendered into a TUI.
const SAFE_BYTE = /[\x21-\x7e]/
const UNSAFE_IN_VALUE = new Set(["%", "[", "]", "=", " "])

// Control, format and bidi code points, which no address, id or context id
// legitimately contains. Escaping them on the way out was never enough: a
// FOREIGN header can write %0A or %1B itself, and a decoder that faithfully
// reverses it hands back a real newline or a real ESC. Then anything that
// interpolates a decoded value into model-visible text carries a forged
// header-shaped line, and a terminal or a log file gets an escape sequence.
// So the policy is applied on both sides — refuse to emit one, refuse to
// accept one — and a value carrying any of these is dropped rather than
// repaired, because a mangled address is a wrong address.
//
// C0 and DEL, C1 (which is where NEL lives), zero-width and directional
// marks, line and paragraph separators, bidi embedding and override,
// invisible operators, directional isolates, and the BOM.
const FORBIDDEN_CODEPOINT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/

/** Longest field a header will carry or accept. Real addresses and ids are far below this. */
const MAX_VALUE_LENGTH = 512
/** A request cannot ask a peer to wait longer than this. */
const MAX_DEADLINE_MINUTES = 1440

const HEADER_RE = /^\[peer (notify|request|reply)((?: [a-z-]+=[^\s\]=]+)*)\]$/
const FIELD_RE = /([a-z-]+)=([^\s\]=]+)/g

/** Reversible: every unsafe byte becomes %XX, so distinct values stay distinct. */
export function encodeHeaderValue(value: string): string {
  let out = ""
  for (const char of value) {
    if (char.length === 1 && SAFE_BYTE.test(char) && !UNSAFE_IN_VALUE.has(char)) {
      out += char
      continue
    }
    for (const byte of new TextEncoder().encode(char)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    }
  }
  return out
}

/** True when a value carries something no legitimate address, id or context id contains. */
export function hasForbiddenCodepoint(value: string): boolean {
  return FORBIDDEN_CODEPOINT.test(value)
}

export function decodeHeaderValue(value: string): string {
  const bytes: number[] = []
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "%" && i + 2 < value.length) {
      const hex = value.slice(i + 1, i + 3)
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        i += 2
        continue
      }
    }
    for (const byte of new TextEncoder().encode(value[i])) bytes.push(byte)
  }
  // ignoreBOM, or a leading U+FEFF is silently eaten and the encode/decode
  // pair stops being injective — the one thing this primitive has to be.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(bytes))
}

export function newMessageID(): string {
  return randomUUID()
}

/** A conversation id, visibly distinct from a message id so the two are never confused in a log. */
export function newContextID(): string {
  return `ctx-${randomUUID()}`
}

/**
 * A field, or nothing when the encoded value is absurdly long. Dropping it is
 * the fail-closed choice: a truncated return address is a wrong address, and
 * every value this formatter's own callers produce is far below the cap.
 */
function field(key: string, value: string): string | undefined {
  if (hasForbiddenCodepoint(value)) return undefined
  const encoded = encodeHeaderValue(value)
  return encoded.length > MAX_VALUE_LENGTH ? undefined : `${key}=${encoded}`
}

export function formatHeader(envelope: PeerEnvelope): string {
  const fields = [
    field("id", envelope.messageID),
    envelope.from ? field("from", envelope.from) : undefined,
    envelope.contextID ? field("context", envelope.contextID) : undefined,
    envelope.inReplyTo ? field("in-reply-to", envelope.inReplyTo) : undefined,
    envelope.taskID ? field("task", envelope.taskID) : undefined,
  ].filter((entry): entry is string => entry !== undefined)
  // Only a request has anything waiting on it, so only a request carries a
  // deadline. Clamped, because a peer must not be told to wait for a year.
  if (envelope.mode === "request" && envelope.deadlineMinutes !== undefined) {
    const minutes = Math.min(MAX_DEADLINE_MINUTES, Math.max(1, Math.round(envelope.deadlineMinutes)))
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
 *
 * Nothing here is authenticated. A sender writes its own header, so `from`,
 * `context` and `in-reply-to` say what the sender claims, exactly like the
 * attribution attributes in peer/claude/codec.ts. Provenance is the
 * authenticated socket the message arrived on; anything that acts on a
 * correlation id must check the sender too, not the id alone.
 */
export function parsePeerEnvelope(text: string): ParsedPeerMessage | undefined {
  const newline = text.indexOf("\n")
  const rawFirstLine = newline === -1 ? text : text.slice(0, newline)
  // A CRLF sender would otherwise fail the end anchor and silently degrade to
  // an unparsed plain message.
  const firstLine = rawFirstLine.endsWith("\r") ? rawFirstLine.slice(0, -1) : rawFirstLine
  const match = firstLine.match(HEADER_RE)
  if (!match) return undefined

  const mode = match[1] as PeerMode
  const envelope: PeerEnvelope = { mode, messageID: "" }
  const seen = new Set<string>()
  for (const entry of match[2].matchAll(FIELD_RE)) {
    const [, key, raw] = entry
    // First wins. A foreign sender can repeat a key, and "last wins" would let
    // the id this parser reports differ from the one another reader took,
    // which is exactly how duplicate suppression and correlation drift apart.
    if (seen.has(key)) continue
    seen.add(key)
    if (raw.length > MAX_VALUE_LENGTH) continue
    const value = decodeHeaderValue(raw)
    // A foreign sender escaped it; decoding it back would hand a real newline
    // or ESC to whatever renders this. Drop the field. When it is the id, the
    // header ends up with none and is rejected outright below — fail closed.
    if (hasForbiddenCodepoint(value)) continue
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
        // Ignored on anything but a request: nothing is waiting on a notify or
        // a reply, so a deadline there is noise at best.
        if (mode !== "request") break
        const minutes = Number(value.replace(/m$/, ""))
        if (Number.isFinite(minutes) && minutes > 0) {
          envelope.deadlineMinutes = Math.min(MAX_DEADLINE_MINUTES, minutes)
        }
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

/**
 * The message without its header, for readers that match on the body's own
 * shape. `peer/delegate.ts` correlates pool-overflow tasks with a
 * `[peer-task-result <id>]` marker anchored at the START of the text; once
 * messages carry a header that anchor no longer matches, delegation silently
 * stops settling and every delegated task times out instead. Anything matching
 * on message text must go through this.
 */
export function peerBody(text: string): string {
  return parsePeerEnvelope(text)?.body ?? text
}

/** True when this message expects the receiver to answer. */
export function expectsReply(envelope: PeerEnvelope): boolean {
  return envelope.mode === "request"
}
