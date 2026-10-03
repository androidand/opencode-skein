import { describe, expect, test } from "bun:test"
import { route } from "@/loop/crew/route"
import type { PeerCandidate } from "@/peer/delegate"

const local = "m3"
const cloud = undefined

function peer(id: string, status: string, provider?: string): PeerCandidate {
  return { owner: "opencode-skein", id, name: id, status, provider }
}

function claude(id: string, status: string): PeerCandidate {
  return { owner: "claude-code", id, name: id, status }
}

describe("route()", () => {
  test("warm idle member on a local host wins", () => {
    const peers = [peer("ses_A", "busy", local), peer("ses_B", "idle", local)]
    const decision = route(peers, new Set([local]))
    expect(decision.kind).toBe("warm")
    if (decision.kind === "warm") expect(decision.peer.id).toBe("ses_B")
  })

  test("only cloud idle member available routes to cloud", () => {
    const peers = [peer("ses_A", "busy", local), claude("pid_1", "idle")]
    const decision = route(peers, new Set([local]))
    expect(decision.kind).toBe("cloud")
    if (decision.kind === "cloud") expect(decision.peer.id).toBe("pid_1")
  })

  test("only free host with no idle peers routes to free-host", () => {
    const peers = [peer("ses_A", "busy", local)]
    const decision = route(peers, new Set([local]))
    expect(decision.kind).toBe("free-host")
  })

  test("nothing available routes to skip", () => {
    const decision = route([], new Set([local]))
    expect(decision.kind).toBe("skip")
  })

  test("warm beats cloud even when cloud is also idle", () => {
    const peers = [claude("pid_1", "idle"), peer("ses_A", "idle", local)]
    const decision = route(peers, new Set([local]))
    expect(decision.kind).toBe("warm")
  })

  test("cloud beats free-host", () => {
    const peers = [peer("ses_A", "busy", local), claude("pid_1", "idle")]
    const decision = route(peers, new Set([local]))
    expect(decision.kind).toBe("cloud")
  })

  test("busy local peer does not count as warm", () => {
    const peers = [peer("ses_A", "busy", local)]
    const decision = route(peers, new Set([local]))
    expect(decision.kind).toBe("free-host")
  })

  test("peer on unknown provider counts as cloud", () => {
    const peers = [peer("ses_A", "idle", "unknown-host")]
    const decision = route(peers, new Set([local]))
    expect(decision.kind).toBe("cloud")
  })

  test("most-recent warm member is returned first (array order preserved)", () => {
    const peers = [peer("ses_A", "idle", local), peer("ses_B", "idle", local)]
    const decision = route(peers, new Set([local]))
    expect(decision.kind).toBe("warm")
    if (decision.kind === "warm") expect(decision.peer.id).toBe("ses_A")
  })

  test("localProviderIDs not matching provider counts as cloud", () => {
    const peers = [peer("ses_A", "idle", "other-host")]
    const decision = route(peers, new Set([local]))
    expect(decision.kind).toBe("cloud")
  })
})
