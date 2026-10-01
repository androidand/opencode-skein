import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { leadVerdictFor } from "../../src/peer/lead-runtime"

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
    let verdict
    withGrant({}, (path) => {
      expect(leadVerdictFor(lead, true, NOW, path).granted).toBe(true)
      rmSync(path)
      verdict = leadVerdictFor(lead, true, NOW, path)
    })
    expect(verdict).toEqual({ granted: false, reason: expect.stringContaining("no grant") })
  })
})
