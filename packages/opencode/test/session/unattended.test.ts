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

describe("Unattended — secrets and the stop-and-ask brake", () => {
  const scoped = { mode: "scoped" as const, extraAllow: [] as string[] }

  test("isSensitivePath: env files and private keys are, an example file and ordinary files are not", () => {
    for (const p of [".env", "/proj/.env", "/proj/app.env", "/proj/.env.production", "/proj/config/prod.env", "/home/x/.ssh/id_rsa", "/x/server.pem", "/x/tls.key", "/x/.netrc", "/x/credentials.json"]) {
      expect({ p, v: Unattended.isSensitivePath(p) }).toEqual({ p, v: true })
    }
    for (const p of ["/proj/.env.example", "/proj/.env.sample", "/proj/src/environment.ts", "/proj/README.md", "/home/x/.ssh/id_rsa.pub", "/proj/src/envelope.ts"]) {
      expect({ p, v: Unattended.isSensitivePath(p) }).toEqual({ p, v: false })
    }
  })

  test("scoped refuses a read or edit of a secret file, even though read and edit are on its list", () => {
    expect(Unattended.decide(scoped, "read", ["/proj/.env"])).toBe("deny")
    expect(Unattended.decide(scoped, "edit", ["/proj/.env.production"])).toBe("deny")
    expect(Unattended.decide(scoped, "read", ["/proj/src/a.ts", "/proj/.env"])).toBe("deny")
    expect(Unattended.decide(scoped, "read", ["/proj/src/a.ts"])).toBe("allow")
    expect(Unattended.decide(scoped, "read", ["/proj/.env.example"])).toBe("allow")
  })

  test("full still allows a secret file (an explicit choice), and bash is not judged by file patterns", () => {
    expect(Unattended.decide({ mode: "full", extraAllow: [] }, "read", ["/proj/.env"])).toBe("allow")
    expect(Unattended.decide(scoped, "bash", ["cat .env"])).toBe("allow")
  })

  test("doom_loop is refused, not waved through: it is the stop-and-ask brake an agent chose to keep", () => {
    expect(Unattended.decide(scoped, "doom_loop")).toBe("deny")
    expect(Unattended.decide({ mode: "full", extraAllow: [] }, "doom_loop")).toBe("allow")
  })

  test("the tool layer passes the patterns through", () => {
    expect(Unattended.toolAskVerdict({ policy: scoped, permission: "read", patterns: ["/p/.env"], autoEnabled: false, queueCeiling: true })).toBe("deny")
  })
})

describe("Unattended.toolAskVerdict — the tool layer that sits in front of Permission.ask", () => {
  const base = { autoEnabled: false, queueCeiling: false }
  const scoped = { mode: "scoped" as const, extraAllow: [] as string[] }

  test("a queue session (the push-deny ceiling) is refused what scoped refuses, instead of being waved through", () => {
    // The bug this exists for: tools.ts skipped the question for any queue session, so the policy
    // was never consulted and the main swarm mode allowed webfetch and outside directories.
    expect(Unattended.toolAskVerdict({ ...base, queueCeiling: true, policy: scoped, permission: "webfetch" })).toBe("deny")
    expect(Unattended.toolAskVerdict({ ...base, queueCeiling: true, policy: scoped, permission: "external_directory" })).toBe("deny")
    expect(Unattended.toolAskVerdict({ ...base, queueCeiling: true, policy: scoped, permission: "bash" })).toBe("allow")
  })

  test("global auto mode is full auto, for every session", () => {
    expect(Unattended.toolAskVerdict({ ...base, autoEnabled: true, policy: scoped, permission: "webfetch" })).toBe("allow")
    expect(Unattended.toolAskVerdict({ ...base, autoEnabled: true, policy: undefined, permission: "webfetch" })).toBe("allow")
  })

  test("a marked session follows its own policy: full allows, off asks a human, extraAllow opens one name", () => {
    expect(Unattended.toolAskVerdict({ ...base, policy: { mode: "full", extraAllow: [] }, permission: "webfetch" })).toBe("allow")
    expect(Unattended.toolAskVerdict({ ...base, policy: { mode: "off", extraAllow: [] }, permission: "bash" })).toBe("ask")
    expect(Unattended.toolAskVerdict({ ...base, policy: { mode: "scoped", extraAllow: ["webfetch"] }, permission: "webfetch" })).toBe("allow")
  })

  test("an unmarked session with the ceiling keeps the earlier behaviour; an ordinary session still asks", () => {
    expect(Unattended.toolAskVerdict({ ...base, queueCeiling: true, policy: undefined, permission: "webfetch" })).toBe("allow")
    expect(Unattended.toolAskVerdict({ ...base, policy: undefined, permission: "bash" })).toBe("ask")
  })

  test("session/tools.ts actually uses it, so the policy cannot be bypassed again by an early return", () => {
    const source = require("fs").readFileSync(require("path").join(import.meta.dir, "../../src/session/tools.ts"), "utf8") as string
    expect(source).toContain("Unattended.toolAskVerdict")
    expect(source).not.toMatch(/const autoEnabled = unattended \|\|/)
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
