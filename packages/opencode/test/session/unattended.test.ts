import { describe, expect, test } from "bun:test"
import { Unattended } from "../../src/session/unattended"
import { SessionID } from "../../src/session/schema"

// What an unattended session (a /loop run and its subagents) may do when nobody can answer a
// permission question. An explicit deny is decided before this is consulted and always wins.
describe("Unattended.decide", () => {
  const scoped = { mode: "scoped" as const, extraAllow: [] as string[] }

  test("scoped (the default) allows what an agent needs inside its own project", () => {
    for (const permission of ["bash", "read", "edit", "glob", "grep", "lsp", "todowrite", "task", "skill"]) {
      expect({ permission, verdict: Unattended.decide(scoped, permission) }).toEqual({ permission, verdict: "allow" })
    }
  })

  test("scoped refuses what reaches outside the project, instead of granting it or hanging", () => {
    for (const permission of ["external_directory", "webfetch", "websearch", "plan_enter", "some_mcp_tool"]) {
      expect({ permission, verdict: Unattended.decide(scoped, permission) }).toEqual({ permission, verdict: "deny" })
    }
  })

  test("an unknown permission is refused: the allow list is closed, so a new kind of ask is never silently granted", () => {
    expect(Unattended.decide(scoped, "brand_new_permission")).toBe("deny")
  })

  test("extraAllow opens exactly the named permissions and nothing else", () => {
    const web = { mode: "scoped" as const, extraAllow: ["webfetch", "websearch"] }
    expect(Unattended.decide(web, "webfetch")).toBe("allow")
    expect(Unattended.decide(web, "websearch")).toBe("allow")
    expect(Unattended.decide(web, "external_directory")).toBe("deny")
  })

  test("full allows everything undecided (the previous behaviour, now an explicit choice)", () => {
    const full = { mode: "full" as const, extraAllow: [] }
    for (const permission of ["bash", "external_directory", "webfetch", "anything_at_all"]) {
      expect(Unattended.decide(full, permission)).toBe("allow")
    }
  })

  test("off leaves the question for a human, as before the unattended fix existed", () => {
    expect(Unattended.decide({ mode: "off", extraAllow: [] }, "bash")).toBe("ask")
  })

  test("a session that is not unattended is never decided here", () => {
    expect(Unattended.decide(undefined, "bash")).toBe("ask")
  })
})

describe("Unattended.policyFromConfig", () => {
  test("scoped by default", () => expect(Unattended.policyFromConfig({})).toEqual({ mode: "scoped", extraAllow: [] }))
  test("auto_mode means full auto", () => expect(Unattended.policyFromConfig({ auto_mode: true }).mode).toBe("full"))
  test("an explicit setting beats auto_mode, both ways", () => {
    expect(Unattended.policyFromConfig({ auto_mode: true, experimental: { unattended_permissions: "scoped" } }).mode).toBe("scoped")
    expect(Unattended.policyFromConfig({ experimental: { unattended_permissions: "full" } }).mode).toBe("full")
    expect(Unattended.policyFromConfig({ experimental: { unattended_permissions: "off" } }).mode).toBe("off")
  })
  test("an unrecognised value falls back to scoped, never to something wider", () => {
    expect(Unattended.policyFromConfig({ experimental: { unattended_permissions: "everything" } }).mode).toBe("scoped")
    expect(Unattended.policyFromConfig({ experimental: { unattended_permissions: "FULL" } }).mode).toBe("scoped")
  })
  test("unattended_allow is carried; non-strings are dropped", () => {
    const p = Unattended.policyFromConfig({ experimental: { unattended_allow: ["webfetch", 7 as never, "websearch"] } })
    expect(p.extraAllow).toEqual(["webfetch", "websearch"])
  })
})

describe("Unattended marking", () => {
  test("a marked session defaults to scoped, and a subagent inherits its parent's policy exactly", () => {
    const parent = SessionID.make("session_parent_policy")
    const child = SessionID.make("session_child_policy")
    Unattended.mark(parent, { mode: "full", extraAllow: ["x"] })
    try {
      Unattended.mark(child, Unattended.policyOf(parent))
      expect(Unattended.policyOf(child)).toEqual({ mode: "full", extraAllow: ["x"] })
      const plain = SessionID.make("session_default_policy")
      Unattended.mark(plain)
      expect(Unattended.policyOf(plain)?.mode).toBe("scoped")
      Unattended.unmark(plain)
    } finally {
      Unattended.unmark(parent)
      Unattended.unmark(child)
    }
    expect(Unattended.isUnattended(parent)).toBe(false)
  })
})
