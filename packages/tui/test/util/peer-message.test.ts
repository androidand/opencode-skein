import { describe, expect, test } from "bun:test"
import type { PeerMessagePart } from "@opencode-ai/sdk/v2"
import { peerMessageLabel } from "../../src/util/peer-message"
import { formatPart } from "../../src/util/transcript"

const part = (over: Partial<PeerMessagePart> = {}): PeerMessagePart =>
  ({
    id: "prt_1",
    sessionID: "ses_me",
    messageID: "msg_1",
    type: "peer-message",
    text: "model text",
    body: "can you check x?",
    from: { harness: "opencode-skein", sessionID: "ses_a", title: "Alpha" },
    mode: "request",
    ...over,
  }) as PeerMessagePart

describe("peerMessageLabel", () => {
  test("names the sender, its id and the mode", () => {
    expect(peerMessageLabel(part())).toBe("Alpha · ses_a · request")
  })

  test("a Claude Code sender is marked as one", () => {
    expect(peerMessageLabel(part({ from: { harness: "claude-code", sessionID: "123", title: "cc" } }))).toBe(
      "cc · Claude Code 123 · request",
    )
  })

  test("a missing mode reads as notify", () => {
    expect(peerMessageLabel(part({ mode: undefined }))).toBe("Alpha · ses_a · notify")
  })
})

describe("transcript", () => {
  test("a received peer message is exported with its sender, not dropped", () => {
    const out = formatPart(part(), { thinking: false, toolDetails: false, assistantMetadata: false } as never)
    expect(out).toContain("Alpha")
    expect(out).toContain("can you check x?")
    expect(out).not.toContain("model text")
  })
})
