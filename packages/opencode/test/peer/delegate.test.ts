import { describe, expect, test } from "bun:test"
import {
  awaitTaskReply,
  buildTaskEnvelope,
  cancelTaskReply,
  pickPeer,
  settleTaskReply,
  type PeerCandidate,
} from "../../src/peer/delegate"
import { formatPeerEnvelope } from "../../src/peer/envelope"

const claude: PeerCandidate = { owner: "claude-code", id: "4242", name: "example-corp-5e", status: "idle" }
const cloudPeer: PeerCandidate = {
  owner: "opencode-skein",
  id: "ses_a",
  name: "A",
  status: "idle",
  provider: "anthropic",
  idleForMs: 5_000,
}
const localPeer: PeerCandidate = { ...cloudPeer, id: "ses_b", name: "B", provider: "gpuhost1", idleForMs: 1 }

describe("pickPeer", () => {
  test("skips busy peers", () => {
    expect(pickPeer({ peers: [{ ...claude, status: "busy" }], localProviderIDs: new Set() })).toBeUndefined()
  })
  test("skips an opencode peer whose model runs on a local host", () => {
    expect(pickPeer({ peers: [localPeer], localProviderIDs: new Set(["gpuhost1"]) })).toBeUndefined()
  })
  test("prefers a Claude Code peer over an opencode cloud peer", () => {
    expect(pickPeer({ peers: [cloudPeer, claude], localProviderIDs: new Set(["gpuhost1"]) })?.id).toBe("4242")
  })
  test("an opencode peer on a cloud provider is eligible", () => {
    expect(pickPeer({ peers: [cloudPeer], localProviderIDs: new Set(["gpuhost1"]) })?.id).toBe("ses_a")
  })
})

describe("task envelope round trip", () => {
  const envelope = buildTaskEnvelope({
    taskID: "ses_task1",
    description: "Review the diff",
    prompt: "Look at src/x.ts and report problems.",
    cwd: "/repo",
    replyTo: "opencode:A2A feature",
    replyTool: "SendMessage",
    deadlineMs: 600_000,
  })
  test("names the task, the reply address and the reply envelope header", () => {
    expect(envelope).toContain("[peer request")
    expect(envelope).toContain("task=ses_task1")
    expect(envelope).toContain("deadline=")
    expect(envelope).toContain('"opencode:A2A feature"')
    expect(envelope).toContain("[peer reply task=ses_task1]")
    expect(envelope).toContain("Look at src/x.ts")
  })
  test("a reply header carries the task id", () => {
    const reply = formatPeerEnvelope({ mode: "reply", messageID: "m1", taskID: "ses_task1" }, "All good.")
    expect(reply).toContain("[peer reply id=m1 task=ses_task1]")
    expect(reply.endsWith("All good.")).toBe(true)
  })
  test("a plain message is not a reply", () => {
    expect(settleTaskReply("hi there")).toBe(false)
  })
})

describe("reply registry", () => {
  test("a matching reply settles the wait", async () => {
    const { promise: waiting } = awaitTaskReply("t1", 5_000)
    const reply = formatPeerEnvelope({ mode: "reply", messageID: "m1", taskID: "t1" }, "done")
    expect(settleTaskReply(reply)).toBe(true)
    expect(await waiting).toEqual({ ok: true, text: "done" })
  })
  test("a reply nobody waits for is not consumed", () => {
    const reply = formatPeerEnvelope({ mode: "reply", messageID: "m1", taskID: "nobody" }, "x")
    expect(settleTaskReply(reply)).toBe(false)
  })
  test("a reply with its own header settles without depending on anything before it", async () => {
    const { promise: waiting } = awaitTaskReply("t4", 5_000)
    const reply = formatPeerEnvelope({ mode: "reply", messageID: "m1", taskID: "t4" }, "done")
    expect(settleTaskReply(reply)).toBe(true)
    expect(await waiting).toEqual({ ok: true, text: "done" })
  })
  test("a reply with no structured header is not consumed", () => {
    // The marker path is retired; a bare `[peer-task-result ...]` line is just text.
    expect(settleTaskReply("[peer-task-result t1]\ndone")).toBe(false)
  })
  test("times out", async () => {
    expect(await (awaitTaskReply("t2", 5)).promise).toEqual({ ok: false, reason: "timeout" })
  })
  test("cancel settles as cancelled and a late reply is not consumed", async () => {
    const { promise: waiting } = awaitTaskReply("t3", 5_000)
    cancelTaskReply("t3")
    expect(await waiting).toEqual({ ok: false, reason: "cancelled" })
    const late = formatPeerEnvelope({ mode: "reply", messageID: "m1", taskID: "t3" }, "late")
    expect(settleTaskReply(late)).toBe(false)
  })
})
