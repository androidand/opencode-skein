// The queue must read a change's tasks.md from that change's own branch, not
// from whatever branch the working tree happens to be on. Reading the wrong one
// reports a stale "next task" and burns loop iterations re-doing finished work.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { Process } from "../../src/util/process"
import { readChangeFile, showRef } from "../../src/loop/spec-queue/branch-read"

const REL = "openspec/changes/change-a/tasks.md"

async function git(cwd: string, ...args: string[]) {
  const out = await Process.text(["git", "-C", cwd, ...args], { nothrow: true, timeout: 10_000 })
  if (out.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.text}`)
}

function write(root: string, text: string) {
  fs.mkdirSync(join(root, "openspec/changes/change-a"), { recursive: true })
  fs.writeFileSync(join(root, REL), text)
}

describe("readChangeFile", () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "branch-read-test-"))
    await git(root, "init", "-q", "-b", "main")
    await git(root, "config", "user.email", "t@example.com")
    await git(root, "config", "user.name", "t")
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test("reads the change's own branch even when the working tree is on another one", async () => {
    write(root, "- [ ] on main\n")
    await git(root, "add", ".")
    await git(root, "commit", "-q", "-m", "main")
    await git(root, "checkout", "-q", "-b", "loop/change-a")
    write(root, "- [x] done on the change branch\n")
    await git(root, "commit", "-q", "-am", "change a")
    await git(root, "checkout", "-q", "main")

    expect(fs.readFileSync(join(root, REL), "utf8")).toBe("- [ ] on main\n")
    expect(readChangeFile(root, "change-a", REL)).toBe("- [x] done on the change branch\n")
  })

  test("falls back to the working tree when the change branch does not exist", async () => {
    write(root, "- [ ] only in the working tree\n")
    await git(root, "add", ".")
    await git(root, "commit", "-q", "-m", "main")

    expect(showRef(root, "change-a", REL)).toBeUndefined()
    expect(readChangeFile(root, "change-a", REL)).toBe("- [ ] only in the working tree\n")
  })

  test("is undefined when neither the branch nor the working tree has the file", async () => {
    await git(root, "commit", "-q", "--allow-empty", "-m", "root")
    expect(readChangeFile(root, "change-a", REL)).toBeUndefined()
  })

  test("does not throw outside a git repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "branch-read-plain-"))
    try {
      write(plain, "- [ ] no git here\n")
      expect(readChangeFile(plain, "change-a", REL)).toBe("- [ ] no git here\n")
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })
})
