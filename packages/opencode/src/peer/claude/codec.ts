// The NDJSON wire protocol confirmed byte-for-byte in
// openspec/changes/claude-peer-protocol-spike/findings.md, "Wire protocol" —
// real frames captured from a genuine SendMessage call, not reconstructed
// from documentation (there is none).
import { randomUUID } from "crypto"

export type Priority = "now" | "next" | "later"

export interface AuthFrame {
  type: "auth"
  token: string
}

export interface MessageFrame {
  msgV: 1
  msg_id: string
  type: "user"
  message: { role: "user"; content: string }
  priority: Priority
  from: string
}

const CLOSING_TAG_RE = /<\/cross-session-message>/gi
const FORGED_ATTR_RE = /from\s*=\s*"/gi

/**
 * Neutralizes any substring that could forge envelope structure or sender
 * identity. Claude's own sender never needed this — it controls both ends of
 * what it sends — but message text reaching this codec can originate from
 * model output, which does not get that guarantee. See findings.md's
 * "Security note for the real implementation".
 */
export function sanitizeMessageText(text: string): string {
  return text.replace(CLOSING_TAG_RE, "&lt;/cross-session-message&gt;").replace(FORGED_ATTR_RE, 'from&#61;"')
}

/**
 * Escapes a value interpolated into an envelope ATTRIBUTE. These carry sender
 * identity, and at least one of them (`fromName`, from the sending session's
 * title) is routinely model-generated, so a raw interpolation lets a crafted
 * title close the attribute and forge the rest of the envelope.
 */
export function sanitizeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\r\n]/g, " ")
}

export function buildEnvelope(input: { from: string; fromName: string; fromMode: string; text: string }): string {
  const from = sanitizeAttribute(input.from)
  const fromName = sanitizeAttribute(input.fromName)
  const fromMode = sanitizeAttribute(input.fromMode)
  const safeText = sanitizeMessageText(input.text)
  return `<cross-session-message from="${from}" from-name="${fromName}" from-mode="${fromMode}">\n${safeText}\n</cross-session-message>`
}

export function buildAuthFrame(token: string): AuthFrame {
  return { type: "auth", token }
}

export function buildMessageFrame(input: {
  from: string
  fromName: string
  fromMode: string
  text: string
  priority?: Priority
}): MessageFrame {
  return {
    msgV: 1,
    msg_id: randomUUID(),
    type: "user",
    message: { role: "user", content: buildEnvelope(input) },
    priority: input.priority ?? "next",
    from: input.from,
  }
}

/** One JSON object per line, trailing newline — confirmed exact framing. */
export function encodeFrames(frames: readonly unknown[]): string {
  return frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n"
}

export interface ParsedEnvelope {
  text: string
  from?: string
  fromName?: string
  fromMode?: string
}

const ENVELOPE_RE =
  /^<cross-session-message from="([^"]*)" from-name="([^"]*)" from-mode="([^"]*)">\n([\s\S]*)\n<\/cross-session-message>$/

/**
 * Strips the confirmed envelope shape from an inbound message's content.
 * Per findings.md's own security note: the returned `from`/`fromName` are
 * for DISPLAY ONLY — a sender can put anything in these attributes, so
 * provenance for authorization purposes is whatever authenticated socket
 * connection this arrived on, never these fields. If the content doesn't
 * match the envelope shape at all, the raw content is returned as `text`
 * rather than dropped.
 */
export function parseEnvelope(content: string): ParsedEnvelope {
  const match = content.match(ENVELOPE_RE)
  if (!match) return { text: content }
  const [, from, fromName, fromMode, text] = match
  return { from, fromName, fromMode, text }
}

export * as ClaudeCodec from "./codec"
