import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  claudePidOf,
  opencodeSenderOf,
  OPENCODE_FROM_PREFIX,
  resolveOpencodeSender,
  returnAddressFor,
} from "../../src/peer/route"
import { MANAGED_BY, writeSidecarRegistration } from "../../src/peer/claude/sidecar-registry"

describe("opencodeSenderOf", () => {
  test("reads the session id out of an opencode envelope address", () => {
    expect(opencodeSenderOf(`${OPENCODE_FROM_PREFIX}ses_abc`)).toBe("ses_abc")
  })
  test("anything else is not an opencode sender", () => {
    expect(opencodeSenderOf("uds:/tmp/cc-socks/123.sock")).toBeUndefined()
    expect(opencodeSenderOf(undefined)).toBeUndefined()
    expect(opencodeSenderOf(OPENCODE_FROM_PREFIX)).toBeUndefined()
  })
})

describe("returnAddressFor", () => {
  test("a session with no sidecar gets the non-connectable placeholder and is marked unreachable", () => {
    // Nothing in this test process has spawned a sidecar for this id.
    expect(returnAddressFor("ses_no_sidecar")).toEqual({
      address: `${OPENCODE_FROM_PREFIX}ses_no_sidecar`,
      reachable: false,
    })
  })
})

describe("claudePidOf", () => {
  test("reads the pid out of a Claude Code socket address", () => {
    expect(claudePidOf("uds:/tmp/cc-socks/22391.sock")).toBe("22391")
    expect(claudePidOf("uds:/private/tmp/cc-socks/7.sock")).toBe("7")
  })
  test("anything without a pid-named socket is undefined", () => {
    expect(claudePidOf(`${OPENCODE_FROM_PREFIX}ses_abc`)).toBeUndefined()
    expect(claudePidOf("uds:/tmp/cc-socks/named.sock")).toBeUndefined()
    expect(claudePidOf(undefined)).toBeUndefined()
  })
})

describe("resolveOpencodeSender", () => {
  let dir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "route-test-"))
    await mkdir(join(dir, "sessions"), { recursive: true })
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    await rm(dir, { recursive: true, force: true })
  })

  test("the placeholder prefix still resolves without touching the registry", async () => {
    expect(await resolveOpencodeSender(`${OPENCODE_FROM_PREFIX}ses_abc`)).toBe("ses_abc")
  })

  test("a real sidecar socket resolves to the owner session that registered it", async () => {
    await writeSidecarRegistration(
      {
        pid: 4242,
        sessionId: "fake-uuid",
        cwd: "/repo",
        startedAt: 1000,
        procStart: "Sat Sep  5 15:15:11 2026",
        peerProtocol: 1,
        messagingSocketPath: "/tmp/cc-socks/4242.sock",
        name: "opencode:owner",
        status: "idle",
        managedBy: MANAGED_BY,
        ownerSessionID: "ses_owner",
      },
      "token",
    )
    expect(await resolveOpencodeSender("uds:/tmp/cc-socks/4242.sock")).toBe("ses_owner")
  })

  test("a socket nobody registered as ours is a foreign (Claude Code) sender", async () => {
    expect(await resolveOpencodeSender("uds:/tmp/cc-socks/999.sock")).toBeUndefined()
    expect(await resolveOpencodeSender(undefined)).toBeUndefined()
  })
})
