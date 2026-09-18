import { describe, expect, test } from "bun:test"
import { resolveClaudePeers } from "../../src/agent/presence-claude"

// Fixture shape captured verbatim from a real, live Claude Code install (see
// openspec/changes/claude-peer-protocol-spike/findings.md) — extra fields
// like `peerFeatures`/`bridgeSessionId` are real and must be tolerated as
// unknown-but-ignorable, not treated as validation failures.
const realRegistryEntry = {
  pid: 3866,
  sessionId: "d1d25a93-76b4-4b14-8fdf-3a9896202a4c",
  cwd: "/home/user/dev/opencode-skein",
  startedAt: 1788621312135,
  procStart: "Sat Sep  5 15:15:11 2026",
  version: "2.1.261",
  peerProtocol: 1,
  peerFeatures: ["notify_idle", "reply_across_default_dirs", "artifact_yield"],
  kind: "interactive",
  entrypoint: "cli",
  pidDomain: "darwin",
  messagingSocketPath: "/tmp/cc-socks/3866.sock",
  name: "opencode-skein-e2",
  nameSource: "derived",
  nameSince: 1788621312135,
  status: "busy",
  updatedAt: 1788637560798,
  statusUpdatedAt: 1788637560798,
  bridgeSessionId: "session_01VNLPKoYAazB85eSHgToec1",
}

describe("resolveClaudePeers", () => {
  test("maps a real registry entry with no fabricated fields", () => {
    const [peer] = resolveClaudePeers({ records: [realRegistryEntry], now: 2000, isAlive: () => true })
    expect(peer).toEqual({
      owner: "claude-code",
      instanceID: "3866",
      sessionID: "d1d25a93-76b4-4b14-8fdf-3a9896202a4c",
      directory: "/home/user/dev/opencode-skein",
      status: "busy",
      lastEventAt: 1788637560798,
      heartbeatAt: 2000,
      canPrompt: false,
      canBtw: false,
      canAbort: false,
    })
  })

  test("idle status maps to idle", () => {
    const [peer] = resolveClaudePeers({
      records: [{ ...realRegistryEntry, status: "idle" }],
      now: 2000,
      isAlive: () => true,
    })
    expect(peer.status).toBe("idle")
  })

  test("absent status maps to busy, per findings.md", () => {
    const { status: _status, ...withoutStatus } = realRegistryEntry
    const [peer] = resolveClaudePeers({ records: [withoutStatus], now: 2000, isAlive: () => true })
    expect(peer.status).toBe("busy")
  })

  test("falls back to startedAt when statusUpdatedAt is absent", () => {
    const { statusUpdatedAt: _s, ...withoutUpdated } = realRegistryEntry
    const [peer] = resolveClaudePeers({ records: [withoutUpdated], now: 2000, isAlive: () => true })
    expect(peer.lastEventAt).toBe(realRegistryEntry.startedAt)
  })

  test("a dead pid reports unreachable, not dropped", () => {
    const [peer] = resolveClaudePeers({ records: [realRegistryEntry], now: 2000, isAlive: () => false })
    expect(peer.status).toBe("unreachable")
  })

  test("control capabilities are always false — read-only source", () => {
    const [peer] = resolveClaudePeers({ records: [realRegistryEntry], now: 2000, isAlive: () => true })
    expect(peer.canPrompt).toBe(false)
    expect(peer.canBtw).toBe(false)
    expect(peer.canAbort).toBe(false)
  })

  test("a malformed record is dropped, never thrown", () => {
    const peers = resolveClaudePeers({
      records: [{ notAClaudeRecord: true }, null, "garbage", 42, realRegistryEntry],
      now: 2000,
      isAlive: () => true,
    })
    expect(peers).toHaveLength(1)
  })

  test("empty input yields an empty roster, not an error", () => {
    expect(resolveClaudePeers({ records: [], now: 2000, isAlive: () => true })).toEqual([])
  })

  test("no agent/provider/model/loop fields are ever fabricated", () => {
    const [peer] = resolveClaudePeers({ records: [realRegistryEntry], now: 2000, isAlive: () => true })
    expect(peer.agent).toBeUndefined()
    expect(peer.provider).toBeUndefined()
    expect(peer.model).toBeUndefined()
    expect(peer.loopID).toBeUndefined()
    expect(peer.loopStatus).toBeUndefined()
  })
})
