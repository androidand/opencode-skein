// The tool description is the model's only account of what this channel can
// do. It once said the Claude channel was one-way; inbound has shipped, and a
// model told replies are impossible will not ask peers questions.
import { describe, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import { join } from "path"

const toolDir = join(import.meta.dir, "../../src/tool")

describe("peer tool descriptions", () => {
  test("send_peer_message no longer claims the Claude channel is outbound-only", async () => {
    const text = await readFile(join(toolDir, "send-peer-message.txt"), "utf8")
    expect(text).not.toMatch(/outbound-only/i)
    expect(text).not.toMatch(/cannot reply back/i)
    expect(text).toMatch(/Peers can answer/)
  })

  test("send_peer_message and peers agree that Claude Code peers are reachable", async () => {
    const [send, peers] = await Promise.all([
      readFile(join(toolDir, "send-peer-message.txt"), "utf8"),
      readFile(join(toolDir, "peers.txt"), "utf8"),
    ])
    expect(peers).toMatch(/messageable/)
    expect(send).toMatch(/Claude Code/)
    expect(send).not.toMatch(/one-way notifications only/)
  })

  test("states that an answer never returns from the call, which is what drove the retry loop", async () => {
    const text = await readFile(join(toolDir, "send-peer-message.txt"), "utf8")
    expect(text).toMatch(/NEVER comes back as the result of this call/)
    expect(text).toMatch(/Do not send the same message again/)
  })
})

describe("peer tool descriptions: contract first, no stale claims", () => {
  test("send_peer_message opens with what it does and shows an example call", async () => {
    const text = await readFile(join(toolDir, "send-peer-message.txt"), "utf8")
    expect(text.indexOf("Example: send_peer_message(")).toBeGreaterThan(-1)
    expect(text.indexOf("Example: send_peer_message(")).toBeLessThan(500)
    expect(text).toContain('exactly "notify"')
  })

  test("a busy target is described as held and delivered, not refused (the code queues it)", async () => {
    const [send, peers] = await Promise.all([
      readFile(join(toolDir, "send-peer-message.txt"), "utf8"),
      readFile(join(toolDir, "peers.txt"), "utf8"),
    ])
    expect(send).toMatch(/held and delivered automatically/)
    expect(send).not.toMatch(/is not delivered/)
    expect(send).not.toMatch(/Retry once/)
    expect(peers).not.toMatch(/delivery is\s+refused/)
  })

  test("peers says it is a tool, not a shell command", async () => {
    const text = await readFile(join(toolDir, "peers.txt"), "utf8")
    expect(text).toMatch(/not a shell\s+command/)
  })

  test("neither description grew", async () => {
    const [send, peers] = await Promise.all([
      readFile(join(toolDir, "send-peer-message.txt"), "utf8"),
      readFile(join(toolDir, "peers.txt"), "utf8"),
    ])
    expect(Buffer.byteLength(send)).toBeLessThanOrEqual(4198)
    expect(Buffer.byteLength(peers)).toBeLessThanOrEqual(4552)
  })
})
