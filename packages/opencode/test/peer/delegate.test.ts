import { describe, expect, test } from "bun:test"
import {
  awaitTaskReply,
  buildTaskEnvelope,
  cancelTaskReply,
  parseTaskReply,
  pickPeer,
  settleTaskReply,
  type PeerCandidate,
} from "../../src/peer/delegate"

const claude: PeerCandidate = { owner: "claude-code", id: "4242", name: "example-corp-5e", status: "idle" }
const cloudPeer: PeerCandidate = {
  owner: "opencode-skein",
  id: "ses_a",
  name: "A",
  status: "idle",
  provider: "anthropic",
  idleForMs: 5_000,
}
const localPeer: PeerCandidate = { ...cloudPeer, id: "ses_b", name: "B", provider: "rocky", idleForMs: 1 }

describe("pickPeer", () => {
  test("skips busy peers", () => {
    expect(pickPeer({ peers: [{ ...claude, status: "busy" }], localProviderIDs: new Set() })).toBeUndefined()
  })
  test("skips an opencode peer whose model runs on a local host", () => {
    expect(pickPeer({ peers: [localPeer], localProviderIDs: new Set(["rocky"]) })).toBeUndefined()
  })
  test("prefers a Claude Code peer over an opencode cloud peer", () => {
    expect(pickPeer({ peers: [cloudPeer, claude], localProviderIDs: new Set(["rocky"]) })?.id).toBe("4242")
  })
  test("an opencode peer on a cloud provider is eligible", () => {
    expect(pickPeer({ peers: [cloudPeer], localProviderIDs: new Set(["rocky"]) })?.id).toBe("ses_a")
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
  test("names the task, the reply address and the marker", () => {
    expect(envelope).toContain("[peer-task ses_task1]")
    expect(envelope).toContain('"opencode:A2A feature"')
    expect(envelope).toContain("[peer-task-result ses_task1]")
    expect(envelope).toContain("Look at src/x.ts")
  })
  test("parseTaskReply reads the marker and strips it", () => {
    expect(parseTaskReply("[peer-task-result ses_task1]\nAll good.")).toEqual({ taskID: "ses_task1", text: "All good." })
    expect(parseTaskReply("  [peer-task-result ses_task1] inline")).toEqual({ taskID: "ses_task1", text: "inline" })
  })
  test("plain messages are not replies", () => {
    expect(parseTaskReply("hi there")).toBeUndefined()
    expect(parseTaskReply("see [peer-task-result x] later")).toBeUndefined()
  })
})

describe("reply registry", () => {
  test("a matching reply settles the wait", async () => {
    const waiting = awaitTaskReply("t1", 5_000)
    expect(settleTaskReply("[peer-task-result t1]\ndone")).toBe(true)
    expect(await waiting).toEqual({ ok: true, text: "done" })
  })
  test("a reply nobody waits for is not consumed", () => {
    expect(settleTaskReply("[peer-task-result nobody]\nx")).toBe(false)
  })
  test("times out", async () => {
    expect(await awaitTaskReply("t2", 5)).toEqual({ ok: false, reason: "timeout" })
  })
  test("cancel settles as cancelled and a late reply is not consumed", async () => {
    const waiting = awaitTaskReply("t3", 5_000)
    cancelTaskReply("t3")
    expect(await waiting).toEqual({ ok: false, reason: "cancelled" })
    expect(settleTaskReply("[peer-task-result t3]\nlate")).toBe(false)
  })
})
