import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, realpathSync } from "fs"
import { mkdir, mkdtemp, rm, writeFile, chmod } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { PublishMerge } from "../../src/policy/merge-run"
import type { PublishPolicy } from "../../src/policy/publish-policy"

// Real git, real repositories: a bare remote and clones of it. The first merge
// driver was only ever tested as strings and produced a command git rejects.

const git = PublishMerge.realGit
const ok = async (args: string[], cwd: string) => {
  const r = await git(args, cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}

let root: string
let remote: string
let work: string

async function commitFile(cwd: string, file: string, content: string, message: string) {
  await writeFile(join(cwd, file), content)
  await ok(["add", file], cwd)
  await ok(["commit", "-q", "-m", message], cwd)
}

async function clone(name: string) {
  const dir = join(root, name)
  await ok(["clone", "-q", remote, dir], root)
  await ok(["config", "user.email", "t@example.com"], dir)
  await ok(["config", "user.name", "t"], dir)
  return dir
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "merge-run-"))
  remote = join(root, "remote.git")
  await ok(["init", "-q", "--bare", "-b", "dev", remote], root)
  const seed = await clone("seed")
  await ok(["checkout", "-q", "-b", "dev"], seed)
  await commitFile(seed, "a.txt", "a\n", "base")
  await ok(["push", "-q", "origin", "dev"], seed)
  work = await clone("work")
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const POLICY = (over: Partial<PublishPolicy.Policy["merge"]> = {}): PublishPolicy.Policy => ({
  version: 1,
  repo: "owner/name",
  visibility: "public",
  commit: { branches: ["loop/*"] },
  push: { remotes: ["origin"], branches: ["loop/*"] },
  merge: { into: ["dev"], method: "squash", requires: ["gates", "review", "ci"], by: ["integrator"], ...over },
  scan: "public-content",
})

/** A branch `loop/x` with one commit on top of remote dev, pushed so the head exists everywhere. */
async function feature(file = "b.txt", content = "b\n") {
  await ok(["checkout", "-q", "-b", "loop/x", "origin/dev"], work)
  await commitFile(work, file, content, "feature")
  const head = await ok(["rev-parse", "HEAD"], work)
  const base = await ok(["merge-base", "origin/dev", head], work)
  return { head, base }
}

const evidence = (head: string, base: string, over: Partial<PublishMerge.Evidence> = {}) => ({
  headSHA: head,
  mergeBase: base,
  reviewVerdict: { verdict: "LGTM" as const, sha: head },
  gates: { passed: true, sha: head },
  ci: { passed: true, sha: head },
  ...over,
})

const run = (e: ReturnType<typeof evidence>, over: Partial<Parameters<typeof PublishMerge.runMerge>[0]> = {}) =>
  PublishMerge.runMerge({
    repo: work,
    policy: POLICY(),
    target: "dev",
    remote: "origin",
    actor: "integrator",
    evidence: e,
    ...over,
  })

const remoteDev = () => ok(["rev-parse", "dev"], remote)
async function expectClean() {
  // No lock and no leftover worktree after ANY outcome.
  const common = await ok(["rev-parse", "--path-format=absolute", "--git-common-dir"], work)
  expect(existsSync(join(common, "skein-merge-dev.lock"))).toBe(false)
  expect((await ok(["worktree", "list", "--porcelain"], work)).split("\n").filter((l) => l.startsWith("worktree ")).length).toBe(1)
}

describe("runMerge against real git", () => {
  test("squash: publishes one commit on top of the remote tip containing the feature", async () => {
    const { head, base } = await feature()
    const tipBefore = await remoteDev()
    const result = await run(evidence(head, base))
    expect(result).toMatchObject({ ok: true, published: true, previous: tipBefore })
    expect(await remoteDev()).toBe((result as { merged: string }).merged)
    expect(await ok(["rev-list", "--parents", "-n", "1", "dev"], remote)).toBe(`${await remoteDev()} ${tipBefore}`)
    expect(await ok(["show", "dev:b.txt"], remote)).toBe("b")
    await expectClean()
  })

  test("merge method creates a two-parent merge commit", async () => {
    const { head, base } = await feature()
    const result = await run(evidence(head, base), { policy: POLICY({ method: "merge" }) })
    expect(result.ok).toBe(true)
    expect((await ok(["rev-list", "--parents", "-n", "1", "dev"], remote)).split(" ").length).toBe(3)
    await expectClean()
  })

  test("merges onto the REMOTE tip, never onto a local branch carrying unpublished work", async () => {
    // A local dev ahead of the remote with a commit that must never be published.
    await ok(["checkout", "-q", "dev"], work)
    await commitFile(work, "secret.txt", "private\n", "local only")
    const { head, base } = await feature()
    await run(evidence(head, base))
    const files = await ok(["ls-tree", "-r", "--name-only", "dev"], remote)
    expect(files).toContain("b.txt")
    expect(files).not.toContain("secret.txt")
  })

  test("a target that moved since the branch point is refused: the evidence covers the head, not head-plus-new-work", async () => {
    const { head } = await feature()
    const other = await clone("other")
    await commitFile(other, "unrelated.txt", "someone else landed this\n", "other work on dev")
    await ok(["push", "-q", "origin", "dev"], other)
    await ok(["fetch", "-q", "origin"], work)
    const base = await ok(["merge-base", "origin/dev", head], work)
    const tip = await remoteDev()
    const result = await run(evidence(head, base))
    expect(result).toMatchObject({ ok: false, stage: "verify", reason: expect.stringContaining("has moved") })
    expect(await remoteDev()).toBe(tip)
    await expectClean()
  })

  test("what is published is exactly the reviewed tree", async () => {
    const { head, base } = await feature()
    for (const method of ["squash", "merge"] as const) {
      const fresh = await run(evidence(head, base), { policy: POLICY({ method }), dryRun: true })
      expect(fresh.ok).toBe(true)
      const merged = (fresh as { merged: string }).merged
      expect(await ok(["rev-parse", `${merged}^{tree}`], work)).toBe(await ok(["rev-parse", `${head}^{tree}`], work))
    }
  })

  test("something that sneaks an extra file into the merge commit is refused, because only the reviewed tree may be published", async () => {
    const { head, base } = await feature()
    const tip = await remoteDev()
    // A hook or a stray process modifying the tree between the merge and the commit.
    const sneaky: PublishMerge.Git = async (args, cwd) => {
      if (args[0] === "commit") {
        await writeFile(join(cwd, "sneaked.txt"), "not reviewed\n")
        await ok(["add", "sneaked.txt"], cwd)
      }
      return git(args, cwd)
    }
    const result = await run(evidence(head, base), { git: sneaky })
    expect(result).toMatchObject({ ok: false, stage: "commit", reason: expect.stringContaining("not the reviewed head's tree") })
    expect(await remoteDev()).toBe(tip)
    await expectClean()
  })

  test("the push runs from the real checkout, so the repository's pre-push hook runs where it is meant to", async () => {
    const { head, base } = await feature()
    const marker = join(root, "pre-push-cwd")
    const hook = join(work, ".git", "hooks", "pre-push")
    await mkdir(join(work, ".git", "hooks"), { recursive: true })
    await writeFile(hook, `#!/bin/sh\npwd > "${marker}"\nexit 0\n`)
    await chmod(hook, 0o755)
    const result = await run(evidence(head, base))
    expect(result.ok).toBe(true)
    const ran = (await Bun.file(marker).text()).trim()
    expect(ran).toBe(realpathSync(work))
  })

  test("a failing pre-push hook blocks publication and the remote does not move", async () => {
    const { head, base } = await feature()
    const hook = join(work, ".git", "hooks", "pre-push")
    await mkdir(join(work, ".git", "hooks"), { recursive: true })
    await writeFile(hook, "#!/bin/sh\necho refused by hook >&2\nexit 1\n")
    await chmod(hook, 0o755)
    const tip = await remoteDev()
    const result = await run(evidence(head, base))
    expect(result).toMatchObject({ ok: false, stage: "push" })
    expect(await remoteDev()).toBe(tip)
    await expectClean()
  })

  test("stale evidence — a merge base that is not the real one — is refused", async () => {
    const { head } = await feature()
    const tip = await remoteDev()
    const fake = "1".repeat(40)
    const result = await run(evidence(head, fake))
    expect(result).toMatchObject({ ok: false, stage: "verify", reason: expect.stringContaining("stale") })
    expect(await remoteDev()).toBe(tip)
  })

  test("a head already contained in the target is refused rather than merged again", async () => {
    const { head, base } = await feature()
    const merge = POLICY({ method: "merge" })
    expect((await run(evidence(head, base), { policy: merge })).ok).toBe(true)
    const tip = await remoteDev()
    const again = await run(evidence(head, base), { policy: merge })
    expect(again).toMatchObject({ ok: false, stage: "verify", reason: expect.stringContaining("already contained") })
    expect(await remoteDev()).toBe(tip)
    await expectClean()
  })

  test("unrelated histories are refused", async () => {
    await ok(["checkout", "-q", "--orphan", "loop/x"], work)
    await commitFile(work, "z.txt", "z\n", "unrelated root")
    const head = await ok(["rev-parse", "HEAD"], work)
    const tip = await remoteDev()
    const result = await run(evidence(head, "2".repeat(40)))
    expect(result).toMatchObject({ ok: false, stage: "verify", reason: expect.stringContaining("unrelated") })
    expect(await remoteDev()).toBe(tip)
    await expectClean()
  })

  test("the remote moving between fetch and push is refused, and the competing commit survives", async () => {
    const { head, base } = await feature()
    const other = await clone("racer")
    let competitor = ""
    const raced: PublishMerge.Git = async (args, cwd) => {
      if (args[0] === "push") {
        await commitFile(other, "race.txt", "r\n", "landed first")
        await ok(["push", "-q", "origin", "dev"], other)
        competitor = await ok(["rev-parse", "HEAD"], other)
      }
      return git(args, cwd)
    }
    const result = await run(evidence(head, base), { git: raced })
    expect(result).toMatchObject({ ok: false, stage: "push" })
    expect(await remoteDev()).toBe(competitor)
    await expectClean()
  })

  test("a repository hook that rejects the commit blocks the merge (no --no-verify)", async () => {
    const { head, base } = await feature()
    const hook = join(root, "work", ".git", "hooks", "pre-commit")
    await mkdir(join(root, "work", ".git", "hooks"), { recursive: true })
    await writeFile(hook, "#!/bin/sh\necho blocked by hook >&2\nexit 1\n")
    await chmod(hook, 0o755)
    const tip = await remoteDev()
    const result = await run(evidence(head, base))
    expect(result).toMatchObject({ ok: false, stage: "commit" })
    expect(await remoteDev()).toBe(tip)
    await expectClean()
  })

  test("dryRun produces the merge but publishes nothing", async () => {
    const { head, base } = await feature()
    const tip = await remoteDev()
    const result = await run(evidence(head, base), { dryRun: true })
    expect(result).toMatchObject({ ok: true, published: false })
    expect(await remoteDev()).toBe(tip)
    await expectClean()
  })

  test("a lock held by another merge is respected and left in place", async () => {
    const { head, base } = await feature()
    const common = await ok(["rev-parse", "--path-format=absolute", "--git-common-dir"], work)
    const lock = join(common, "skein-merge-dev.lock")
    await mkdir(lock)
    const tip = await remoteDev()
    const result = await run(evidence(head, base))
    expect(result).toMatchObject({ ok: false, stage: "lock" })
    expect(existsSync(lock)).toBe(true) // the loser must not delete the winner's lock
    expect(await remoteDev()).toBe(tip)
  })

  test("rebase is refused rather than approximated", async () => {
    const { head, base } = await feature()
    const result = await run(evidence(head, base), { policy: POLICY({ method: "rebase" }) })
    expect(result).toMatchObject({ ok: false, stage: "decision" })
  })
})

describe("runMerge refuses before touching git", () => {
  const calls: string[][] = []
  const counting: PublishMerge.Git = async (args, cwd) => {
    calls.push(args)
    return git(args, cwd)
  }
  beforeEach(() => (calls.length = 0))

  const SHA = "a".repeat(40)
  const sameHead = (h: string) => ({
    headSHA: h,
    reviewVerdict: { verdict: "LGTM" as const, sha: h },
    gates: { passed: true, sha: h },
    ci: { passed: true, sha: h },
  })
  const base = "b".repeat(40)
  const cases: [string, Partial<Parameters<typeof PublishMerge.runMerge>[0]>, Partial<ReturnType<typeof evidence>>][] = [
    ["an actor the policy does not list", { actor: "model" }, {}],
    ["a target the policy does not grant", { target: "main" }, {}],
    ["a target that would be read as an option", { target: "-s" }, {}],
    ["a remote the policy does not grant", { remote: "upstream" }, {}],
    ["a remote that would be read as an option", { remote: "--upload-pack=x" }, {}],
    // Every piece of evidence names the same bad head, so the head check is the only thing that can refuse.
    ["an abbreviated head", {}, sameHead("abc123")],
    ["a head that would be read as an option", {}, sameHead("-s ours")],
    ["no verdict", {}, { reviewVerdict: undefined }],
    ["a NEEDS_WORK verdict", {}, { reviewVerdict: { verdict: "NEEDS_WORK", sha: SHA } }],
    ["a verdict for an earlier commit", {}, { reviewVerdict: { verdict: "LGTM", sha: "c".repeat(40) } }],
    ["gates that ran on an earlier commit", {}, { gates: { passed: true, sha: "c".repeat(40) } }],
    ["CI that failed", {}, { ci: { passed: false, sha: SHA } }],
    ["missing CI evidence when the policy requires it", {}, { ci: undefined }],
  ]
  test("a target the policy itself grants but that git would read as an option is still refused", async () => {
    const policy = POLICY({ into: ["-s"] })
    const result = await run(evidence(SHA, base), { policy, target: "-s", git: counting })
    expect(result).toMatchObject({ ok: false, stage: "decision", reason: expect.stringContaining("not a safe branch name") })
    expect(calls).toHaveLength(0)
  })

  test("a remote the policy itself grants but that git would read as an option is still refused", async () => {
    const policy: PublishPolicy.Policy = { ...POLICY(), push: { remotes: ["--upload-pack=x"], branches: ["loop/*"] } }
    const result = await run(evidence(SHA, base), { policy, remote: "--upload-pack=x", git: counting })
    expect(result).toMatchObject({ ok: false, stage: "decision" })
    expect(calls).toHaveLength(0)
  })

  for (const [name, over, ev] of cases) {
    test(name, async () => {
      const e = { ...evidence(SHA, base), ...ev }
      const result = await run(e as ReturnType<typeof evidence>, { ...over, git: counting })
      expect(result).toMatchObject({ ok: false, stage: "decision" })
      expect(calls).toHaveLength(0)
    })
  }
})
