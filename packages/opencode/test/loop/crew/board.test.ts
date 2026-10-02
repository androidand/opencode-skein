import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { deriveBoard, renderBoard, type Board } from "@/loop/crew/board"
import { type ClaimInfo, ClaimID } from "@/loop/crew/claims"
import { ProjectV2 } from "@opencode-ai/core/project"
import type { QueueChange } from "@/loop/spec-queue/queue"

const sessionA = "ses-a"
const sessionB = "ses-b"
const projectID = ProjectV2.ID.make("test-project")

function claim(overrides: Partial<ClaimInfo> & { slug: string; holderSession: string } = {} as never): ClaimInfo {
  const now = Date.now()
  return {
    id: ClaimID.make(`claim-${overrides.slug ?? "x"}`),
    projectID,
    slug: overrides.slug,
    kind: overrides.kind ?? "implement",
    holderSession: overrides.holderSession,
    holderHarness: overrides.holderHarness ?? "opencode-skein",
    holderName: overrides.holderName,
    branch: overrides.branch,
    worktree: overrides.worktree,
    providerID: overrides.providerID,
    modelID: overrides.modelID,
    gate: overrides.gate ?? "implement",
    since: overrides.since ?? now,
    heartbeat: overrides.heartbeat ?? now,
    releasedAt: overrides.releasedAt,
    releaseReason: overrides.releaseReason,
  }
}

function fixtureTree(input: Record<string, { tasks?: string; blocker?: string }>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crew-board-"))
  for (const [slug, files] of Object.entries(input)) {
    const dir = path.join(root, "openspec", "changes", slug)
    fs.mkdirSync(dir, { recursive: true })
    if (files.tasks !== undefined) fs.writeFileSync(path.join(dir, "tasks.md"), files.tasks)
    if (files.blocker !== undefined) {
      fs.mkdirSync(path.join(dir, ".skein"), { recursive: true })
      fs.writeFileSync(path.join(dir, ".skein", "blocker.md"), files.blocker)
    }
  }
  return root
}

const OPEN = "- [ ] 1.1 open task\n"
const DONE = "- [x] 1.1 closed task\n"

describe("deriveBoard", () => {
  test("reports no own claim when the session holds nothing", () => {
    const root = fixtureTree({ "a-change": { tasks: OPEN } })
    const board = deriveBoard({ root, claims: { live: [], abandoned: [] }, sessionID: sessionA })
    expect(board.own.title).toBe("My claim")
    expect(board.own.items).toContain("(none — pick one below)")
  })

  test("reports the session's own claim as holding", () => {
    const root = fixtureTree({ "a-change": { tasks: OPEN } })
    const own = claim({ slug: "a-change", holderSession: sessionA })
    const board = deriveBoard({ root, claims: { live: [own], abandoned: [] }, sessionID: sessionA })
    expect(board.own.items[0]).toContain("holding a-change")
    expect(board.own.items[0]).toContain("age:")
  })

  test("my claim is excluded from unclaimed", () => {
    const root = fixtureTree({ "a-change": { tasks: OPEN } })
    const own = claim({ slug: "a-change", holderSession: sessionA })
    const board = deriveBoard({ root, claims: { live: [own], abandoned: [] }, sessionID: sessionA })
    expect(board.unclaimed.items.some((i) => i.startsWith("a-change"))).toBe(false)
  })

  test("live claims from other sessions appear in Live claims", () => {
    const root = fixtureTree({ "a-change": { tasks: OPEN }, "b-change": { tasks: OPEN } })
    const a = claim({ slug: "a-change", holderSession: sessionA, gate: "implement" })
    const b = claim({ slug: "b-change", holderSession: sessionB, gate: "verify" })
    const board = deriveBoard({ root, claims: { live: [a, b], abandoned: [] }, sessionID: sessionA })
    expect(board.live.items.some((i) => i.includes("b-change"))).toBe(true)
    // The holder's own claim must not appear in the live section.
    expect(board.live.items.some((i) => i.includes("a-change"))).toBe(false)
  })

  test("a quiet board has empty live and unclaimed", () => {
    const root = fixtureTree({})
    const board = deriveBoard({ root, claims: { live: [], abandoned: [] }, sessionID: sessionA })
    expect(board.live.items).toContain("(quiet)")
    expect(board.unclaimed.items).toContain("(backlog empty)")
  })

  test("abandoned claims surface when heartbeat is stale", () => {
    const root = fixtureTree({ "stale-change": { tasks: OPEN } })
    const now = Date.now()
    const stale = claim({ slug: "stale-change", holderSession: sessionB, since: now - 120_000, heartbeat: now - 120_000 })
    const fresh = claim({ slug: "fresh-change", holderSession: sessionB, since: now, heartbeat: now })
    const board = deriveBoard({ root, claims: { live: [fresh], abandoned: [stale] }, sessionID: sessionA })
    expect(board.abandoned.items.some((i) => i.includes("stale-change"))).toBe(true)
    expect(board.abandoned.items.some((i) => i.includes("fresh-change"))).toBe(false)
  })

  test("quarantined changes appear in Decide", () => {
    const root = fixtureTree({
      "sick-change": { tasks: OPEN, blocker: "# something broke" },
      "a-change": { tasks: OPEN },
    })
    const board = deriveBoard({ root, claims: { live: [], abandoned: [] }, sessionID: sessionA })
    expect(board.decide.items.some((i) => i.includes("sick-change"))).toBe(true)
    expect(board.decide.items.some((i) => i.includes("a-change"))).toBe(false)
  })

  test("intake- prefixed changes appear in Triage when unclaimed", () => {
    const root = fixtureTree({
      "intake-feat-x": { tasks: OPEN },
      "normal-change": { tasks: OPEN },
    })
    const board = deriveBoard({ root, claims: { live: [], abandoned: [] }, sessionID: sessionA })
    expect(board.triage.items.some((i) => i.includes("intake-feat-x"))).toBe(true)
    // Normal changes do not go in triage.
    expect(board.triage.items.some((i) => i.includes("normal-change"))).toBe(false)
  })

  test("a live triage claim suppresses the intake item from triage", () => {
    const root = fixtureTree({ "intake-feat-x": { tasks: OPEN } })
    const triage = claim({ slug: "intake-feat-x", holderSession: sessionB, kind: "triage" })
    const board = deriveBoard({ root, claims: { live: [triage], abandoned: [] }, sessionID: sessionA })
    expect(board.triage.items.some((i) => i.includes("intake-feat-x"))).toBe(false)
  })

  test("unclaimed shows at most five items", () => {
    const root = fixtureTree({
      "a": { tasks: OPEN },
      "b": { tasks: OPEN },
      "c": { tasks: OPEN },
      "d": { tasks: OPEN },
      "e": { tasks: OPEN },
      "f": { tasks: OPEN },
      "g": { tasks: OPEN },
    })
    const board = deriveBoard({ root, claims: { live: [], abandoned: [] }, sessionID: sessionA })
    // Five is the cap; the sixth and seventh must be absent.
    const items = board.unclaimed.items.filter((i) => /^ [a-g]$/.test(i) || i.match(/^[a-g] /))
    expect(items).toHaveLength(5)
  })

  test("complete changes do not appear in unclaimed", () => {
    const root = fixtureTree({ "done": { tasks: DONE }, "open": { tasks: OPEN } })
    const board = deriveBoard({ root, claims: { live: [], abandoned: [] }, sessionID: sessionA })
    expect(board.unclaimed.items.some((i) => i.includes("done"))).toBe(false)
    expect(board.unclaimed.items.some((i) => i.includes("open"))).toBe(true)
  })
})

describe("renderBoard", () => {
  test("renders every section with a heading", () => {
    const board: Board = {
      own: { title: "My claim", items: ["holding x"] },
      live: { title: "Live claims", items: ["(quiet)"] },
      abandoned: { title: "Abandoned", items: ["(none)"] },
      review: { title: "Review", items: ["(none — PR detection not yet active)"] },
      integrate: { title: "Integrate", items: ["(none — PR detection not yet active)"] },
      triage: { title: "Triage", items: ["(none)"] },
      decide: { title: "Decide", items: ["(none — the crew is clear)"] },
      unclaimed: { title: "Unclaimed", items: ["(backlog empty)"] },
    }
    const text = renderBoard(board)
    expect(text).toContain("## My claim")
    expect(text).toContain("## Live claims")
    expect(text).toContain("## Abandoned")
    expect(text).toContain("## Review")
    expect(text).toContain("## Integrate")
    expect(text).toContain("## Triage")
    expect(text).toContain("## Decide")
    expect(text).toContain("## Unclaimed")
  })

  test("the rendered text is non-empty when the board has content", () => {
    const root = fixtureTree({ "a-change": { tasks: OPEN } })
    const board = deriveBoard({ root, claims: { live: [], abandoned: [] }, sessionID: sessionA })
    const text = renderBoard(board)
    expect(text.length).toBeGreaterThan(50)
  })
})
