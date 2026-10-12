import type { PeerMessagePart } from "@opencode-ai/sdk/v2"

/** One line identifying who sent a received peer message and how it expects to be treated. */
export function peerMessageLabel(part: PeerMessagePart): string {
  const sender =
    part.from.harness === "claude-code" ? `Claude Code ${part.from.sessionID}` : part.from.sessionID
  return `${part.from.title} · ${sender} · ${part.mode ?? "notify"}`
}
