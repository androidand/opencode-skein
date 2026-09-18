// Two worktrees of one repository share a git common dir; two clones do not.
// That difference is what separates "divide the work, we share an index" from
// "coordinate on interfaces, we share nothing".
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { Process } from "../../src/util/process"
import { repoRoot, repoRoots } from "../../src/util/git-branch"

async function git(cwd: string, ...args: string[]) {
  const out = await Process.text(["git", "-C", cwd, ...args], { nothrow: true, timeout: 10_000 })
  if (out.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.text}`)
}

describe("repoRoot", () => {
  let base: string
  let main: string
  let other: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "repo-root-test-"))
    main = join(base, "main")
    other = join(base, "other")
    for (const dir of [main, other]) {
      await Process.text(["mkdir", "-p", dir], { nothrow: true })
      await git(dir, "init", "-q", "-b", "main")
      await git(dir, "config", "user.email", "t@example.com")
      await git(dir, "config", "user.name", "t")
      await git(dir, "commit", "-q", "--allow-empty", "-m", "root")
    }
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  test("a linked worktree resolves to the same repository as its main checkout", async () => {
    const linked = join(base, "wt")
    await git(main, "worktree", "add", "-q", "-b", "side", linked)
    const now = Date.now()
    const [a, b] = await Promise.all([repoRoot(main, now), repoRoot(linked, now)])
    expect(a).toBeDefined()
    expect(b).toBe(a!)
  })

  test("a separate repository resolves to a different one", async () => {
    const now = Date.now()
    const [a, b] = await Promise.all([repoRoot(main, now), repoRoot(other, now)])
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(b).not.toBe(a!)
  })

  test("a directory that is not a repository has no entry rather than a wrong one", async () => {
    const plain = join(base, "plain")
    await Process.text(["mkdir", "-p", plain], { nothrow: true })
    const map = await repoRoots([main, plain], Date.now() + 1)
    expect(map.has(main)).toBe(true)
    expect(map.has(plain)).toBe(false)
  })
})
