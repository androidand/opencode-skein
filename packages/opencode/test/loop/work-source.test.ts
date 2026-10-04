import { expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { getWorkItems } from "@/loop/spec-queue/work-source"

function makeRepo(base: string, name: string, opts: { binding?: boolean; changes?: string[] } = {}) {
  const repo = path.join(base, name)
  const changesDir = path.join(repo, "openspec", "changes")
  fs.mkdirSync(changesDir, { recursive: true })

  for (const slug of opts.changes ?? ["test-change"]) {
    const changeDir = path.join(changesDir, slug)
    fs.mkdirSync(changeDir, { recursive: true })
    fs.writeFileSync(path.join(changeDir, "proposal.md"), `# ${slug}\n\nA test change.\n`)
    fs.writeFileSync(path.join(changeDir, "tasks.md"), `# Tasks\n\n- [ ] Task 1\n`)
  }

  if (opts.binding) {
    const specsyncDir = path.join(repo, ".specsync")
    fs.mkdirSync(specsyncDir, { recursive: true })
    fs.writeFileSync(
      path.join(specsyncDir, "board.json"),
      JSON.stringify({
        project_id: "123",
        bindings: { "test-change": { item_id: "456", provider: "github-projects" } },
      }),
    )
  }

  return repo
}

function runWorkSource(root: string, repos?: string[]) {
  return Effect.runPromise(getWorkItems(root, repos))
}

test("disk fallback returns eligible changes for unsynced repos", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worksource-test-"))
  try {
    const repo = makeRepo(tmp, "unsynced-repo", { changes: ["change-a", "change-b"] })

    const result = await runWorkSource(tmp, [repo])

    expect(result.scanned).toContain(repo)
    expect(result.items.length).toBe(2)
    expect(result.items.map((i) => i.change).sort()).toEqual(["change-a", "change-b"])
    expect(result.items.every((i) => i.reason === "fallback=disk")).toBe(true)
    expect(result.items.every((i) => i.item === "")).toBe(true)
    expect(result.items.every((i) => i.repo === repo)).toBe(true)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("synced repo is not picked up by disk fallback", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worksource-test-"))
  try {
    const synced = makeRepo(tmp, "synced-repo", { binding: true, changes: ["synced-change"] })
    const unsynced = makeRepo(tmp, "unsynced-repo", { changes: ["unsynced-change"] })

    const result = await runWorkSource(tmp, [synced, unsynced])

    const syncedItems = result.items.filter((i) => i.repo === synced)
    const unsyncedItems = result.items.filter((i) => i.repo === unsynced)

    // Unsynced repo should have disk fallback items
    expect(unsyncedItems.length).toBe(1)
    expect(unsyncedItems[0].change).toBe("unsynced-change")
    expect(unsyncedItems[0].reason).toBe("fallback=disk")

    // Synced repo items should NOT come from disk fallback
    const diskFallbackSynced = syncedItems.filter((i) => i.reason === "fallback=disk")
    expect(diskFallbackSynced.length).toBe(0)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("empty directory returns no items", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worksource-test-"))
  try {
    const result = await runWorkSource(tmp)
    expect(result.items).toEqual([])
    expect(result.scanned).toEqual([])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("repo without openspec directory is skipped", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worksource-test-"))
  try {
    const noOpenspec = path.join(tmp, "no-openspec")
    fs.mkdirSync(noOpenspec, { recursive: true })

    const result = await runWorkSource(tmp, [noOpenspec])

    expect(result.scanned).toContain(noOpenspec)
    expect(result.items).toEqual([])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("discoverRepos finds sibling repos with openspec", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worksource-test-"))
  try {
    const repo1 = makeRepo(tmp, "repo1", { changes: ["change1"] })
    const repo2 = makeRepo(tmp, "repo2", { changes: ["change2"] })
    const noOpenspec = path.join(tmp, "no-openspec")
    fs.mkdirSync(noOpenspec, { recursive: true })

    const result = await runWorkSource(tmp)

    expect(result.scanned).toContain(repo1)
    expect(result.scanned).toContain(repo2)
    expect(result.scanned).not.toContain(noOpenspec)
    expect(result.items.length).toBe(2)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
