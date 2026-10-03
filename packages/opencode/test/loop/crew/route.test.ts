import { expect, test } from "bun:test"
import { route } from "../../../src/loop/crew/route"
import type { PeerCandidate } from "../../../src/peer/delegate"
import type { HostCapacity } from "../../../src/local/placement"

const localProviderIDs = new Set(["local-gpu-1", "local-gpu-2"])

function warmPeer(overrides: Partial<PeerCandidate> = {}): PeerCandidate {
  return {
    owner: "opencode-skein",
    id: "ses_warm",
    name: "warm-member",
    status: "idle",
    provider: "local-gpu-1",
    idleForMs: 1000,
    ...overrides,
  }
}

function cloudPeer(overrides: Partial<PeerCandidate> = {}): PeerCandidate {
  return {
    owner: "opencode-skein",
    id: "ses_cloud",
    name: "cloud-member",
    status: "idle",
    provider: "cloud-provider",
    idleForMs: 500,
    ...overrides,
  }
}

function claudePeer(overrides: Partial<PeerCandidate> = {}): PeerCandidate {
  return {
    owner: "claude-code",
    id: "12345",
    name: "claude-session",
    status: "idle",
    idleForMs: 2000,
    ...overrides,
  }
}

function freeHost(free: number, overrides: Partial<HostCapacity> = {}): HostCapacity {
  return {
    providerID: "local-gpu-1",
    reachable: true,
    reserved: 0,
    free,
    ...overrides,
  }
}

function busyHost(overrides: Partial<HostCapacity> = {}): HostCapacity {
  return {
    providerID: "local-gpu-1",
    reachable: true,
    reserved: 2,
    free: 0,
    ...overrides,
  }
}

test("route: warm member available", () => {
  const decision = route({
    modelID: "test-model",
    peers: [warmPeer(), cloudPeer()],
    hosts: [freeHost(2)],
    localProviderIDs,
  })
  expect(decision.kind).toBe("warm")
  if (decision.kind === "warm") {
    expect(decision.peer.id).toBe("ses_warm")
  }
})

test("route: warm member takes priority over cloud", () => {
  const decision = route({
    modelID: "test-model",
    peers: [cloudPeer(), warmPeer()],
    hosts: [],
    localProviderIDs,
  })
  expect(decision.kind).toBe("warm")
})

test("route: only cloud available (no warm)", () => {
  const decision = route({
    modelID: "test-model",
    peers: [cloudPeer()],
    hosts: [],
    localProviderIDs,
  })
  expect(decision.kind).toBe("cloud")
  if (decision.kind === "cloud") {
    expect(decision.peer.id).toBe("ses_cloud")
  }
})

test("route: claude-code peer counts as cloud", () => {
  const decision = route({
    modelID: "test-model",
    peers: [claudePeer()],
    hosts: [],
    localProviderIDs,
  })
  expect(decision.kind).toBe("cloud")
  if (decision.kind === "cloud") {
    expect(decision.peer.owner).toBe("claude-code")
  }
})

test("route: only a free host available (no peers)", () => {
  const decision = route({
    modelID: "test-model",
    peers: [],
    hosts: [freeHost(3)],
    localProviderIDs,
  })
  expect(decision.kind).toBe("free-host")
  if (decision.kind === "free-host") {
    expect(decision.host.providerID).toBe("local-gpu-1")
    expect(decision.host.free).toBe(3)
  }
})

test("route: idle local peer is warm even if its host has no free slots", () => {
  // An idle peer on a local provider is "warm" — it can serve the model
  // without a queue (the model is already loaded or can be loaded).
  const decision = route({
    modelID: "test-model",
    peers: [warmPeer({ provider: "local-gpu-2" })],
    hosts: [busyHost({ providerID: "local-gpu-2" })],
    localProviderIDs,
  })
  expect(decision.kind).toBe("warm")
})

test("route: nothing free — all peers busy or non-local, all hosts full", () => {
  const decision = route({
    modelID: "test-model",
    peers: [
      // Busy peer.
      warmPeer({ status: "busy" }),
      // Cloud peer that is busy.
      cloudPeer({ status: "busy" }),
    ],
    hosts: [busyHost()],
    localProviderIDs,
  })
  expect(decision.kind).toBe("board")
})

test("route: unreachable host is not free", () => {
  const decision = route({
    modelID: "test-model",
    peers: [],
    hosts: [{ providerID: "local-gpu-1", reachable: false, reserved: 0, free: 5 }],
    localProviderIDs,
  })
  expect(decision.kind).toBe("board")
})

test("route: picks the free host with the most free slots", () => {
  const decision = route({
    modelID: "test-model",
    peers: [],
    hosts: [freeHost(1), freeHost(4), freeHost(2)],
    localProviderIDs,
  })
  expect(decision.kind).toBe("free-host")
  if (decision.kind === "free-host") {
    expect(decision.host.free).toBe(4)
  }
})
