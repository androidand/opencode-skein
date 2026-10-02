import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { leadVerdictFor, processStartTime } from "../../src/peer/lead-runtime"

const NOW = 1_790_000_000_000

function withGrant(overrides: Record<string, unknown>, run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "lead-runtime-"))
  const path = join(dir, "lead.json")
  try {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        id: "lead-rt1",
        lead: { harness: "claude-code", pid: process.pid, address: "uds:/tmp/cc-socks/1.sock" },
        scopes: ["assign"],
        delegates: [],
        issuedAt: NOW - 1000,
        expiresAt: NOW + 60_000,
        issuedBy: "user:cli",
        ...overrides,
      }),
    )
    chmodSync(path, 0o600)
    run(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const lead = { harness: "claude-code" as const, pid: process.pid, address: "uds:/tmp/cc-socks/1.sock" }

describe("leadVerdictFor", () => {
  test("a valid grant file plus follow grants the lead", () => {
    withGrant({}, (path) => {
      expect(leadVerdictFor(lead, true, NOW, path)).toMatchObject({ granted: true, grantID: "lead-rt1" })
    })
  })

  test("without follow nothing is granted, even for the lead", () => {
    withGrant({}, (path) => {
      expect(leadVerdictFor(lead, false, NOW, path).granted).toBe(false)
    })
  })

  test("a lead pid that is no longer running invalidates the grant", () => {
    withGrant({ lead: { harness: "claude-code", pid: 2_147_483_000, address: "uds:/tmp/cc-socks/1.sock" } }, (path) => {
      expect(leadVerdictFor({ ...lead, pid: 2_147_483_000 }, true, NOW, path).granted).toBe(false)
    })
  })

  test("revoking (deleting) the file takes effect on the next message — nothing is cached", () => {
    let verdict: ReturnType<typeof leadVerdictFor> | undefined
    withGrant({}, (path) => {
      expect(leadVerdictFor(lead, true, NOW, path).granted).toBe(true)
      rmSync(path)
      verdict = leadVerdictFor(lead, true, NOW, path)
    })
    expect(verdict).toEqual({ granted: false, reason: expect.stringContaining("no grant") })
  })
})

describe("a session-length grant against REAL processes", () => {
  const own = { harness: "claude-code" as const, pid: process.pid, address: "uds:/tmp/cc-socks/1.sock" }
  const write = (procStart: string | undefined, run: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "lead-real-"))
    const path = join(dir, "lead.json")
    try {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          id: "lead-real1",
          lead: { harness: "claude-code", pid: process.pid, address: "uds:/tmp/cc-socks/1.sock", ...(procStart ? { procStart } : {}) },
          scopes: ["assign"],
          delegates: [],
          issuedAt: Date.now() - 1000,
          expiresAt: null,
          issuedBy: "user:cli",
        }),
      )
      chmodSync(path, 0o600)
      run(path)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("the OS reports a stable start time for a live process, and nothing for one that does not exist", () => {
    const first = processStartTime(process.pid)
    expect(first).toBeTruthy()
    expect(processStartTime(process.pid)).toBe(first)
    expect(processStartTime(2_147_483_000)).toBeUndefined()
  })

  test("granted while the recorded start time is the real one — however old the grant is", () => {
    write(processStartTime(process.pid), (path) => {
      expect(leadVerdictFor(own, true, Date.now() + 90 * 24 * 3_600_000, path)).toMatchObject({ granted: true, expiresAt: null })
    })
  })

  test("a pid that was REUSED (a different start time recorded) is not the lead", () => {
    write("Mon Jan  1 00:00:00 2001", (path) => {
      expect(leadVerdictFor(own, true, Date.now(), path).granted).toBe(false)
    })
  })

  test("a session grant with no process identity at all is refused", () => {
    write(undefined, (path) => {
      expect(leadVerdictFor(own, true, Date.now(), path).granted).toBe(false)
    })
  })
})
