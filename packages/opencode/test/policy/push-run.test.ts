import { describe, expect, test } from "bun:test"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { Process } from "@/util/process"
import type { PublishPolicy } from "@/policy/publish-policy"
import { PublishPushRun } from "@/policy/push-run"

// Real git against scratch remotes, because the class of bug this covers — an
// argument becoming an option — is invisible to a test that only inspects a
// string. Another session found exactly that in the merge driver's argv: it built
// `git merge --no-edit squash dev <sha>`, which real git rejects, and no test ran
// it. These run the command.

const POLICY: PublishPolicy.Policy = {
  version: 1,
  repo: "example/repo",
  visibility: "private",
  commit: { branches: ["loop/*"] },
  push: { remotes: ["origin"], branches: ["loop/*"] },
  merge: { into: ["dev"], method: "squash", requires: ["gates", "review"], by: ["integrator"] },
}

const git = (cwd: string, args: string[]) => Process.text(["git", ...args], { cwd, nothrow: true })
const push = (cwd: string, remote: string, branch: string) => PublishPushRun.run({ cwd, policy: POLICY, remote, branch })
const gitText = async (cwd: string, args: string[]) => (await git(cwd, args)).text.trim()

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "publish-push-"))
  const remote = path.join(root, "remote.git")
  const work = path.join(root, "work")
  await git(root, ["init", "-q", "--bare", remote])
  await git(root, ["init", "-q", work])
  const g = (args: string[]) => git(work, args)
  await g(["config", "user.email", "t@example.com"])
  await g(["config", "user.name", "t"])
  await Bun.write(path.join(work, "a.txt"), "a")
  await g(["add", "."])
  await g(["commit", "-qm", "one"])
  await g(["branch", "-M", "dev"])
  await g(["checkout", "-q", "-b", "loop/x"])
  await Bun.write(path.join(work, "x.txt"), "x")
  await g(["add", "."])
  await g(["commit", "-qm", "loop work"])
  await g(["remote", "add", "origin", remote])
  await g(["push", "-q", "origin", "dev", "loop/x"])
  return {
    remote,
    work,
    ref: async (name: string) => (await gitText(remote, ["rev-parse", name])).split("\n")[0],
    names: async () => (await gitText(remote, ["for-each-ref", "--format=%(refname)"])).split("\n").filter(Boolean),
  }
}

describe("push argv construction", () => {
  test("builds an argv for a granted branch", () => {
    const argv = PublishPushRun.buildArgv({ policy: POLICY, remote: "origin", branch: "loop/x" })
    expect(argv).toEqual({ ok: true, argv: ["push", "--", "origin", "HEAD:refs/heads/loop/x"] })
  })

  test("ends option parsing before the positional arguments", () => {
    // `--` is what makes the positional slots safe even if a name check were
    // bypassed: git reads what follows as arguments, not flags.
    const argv = PublishPushRun.buildArgv({ policy: POLICY, remote: "origin", branch: "loop/x" })
    expect(argv.ok && argv.argv[1]).toBe("--")
  })

  test("refuses a remote that would be read as an option", () => {
    for (const remote of ["-s", "--receive-pack=evil", "-u"]) {
      const result = PublishPushRun.buildArgv({ policy: POLICY, remote, branch: "loop/x" })
      expect({ remote, ok: result.ok }).toEqual({ remote, ok: false })
    }
  })

  test("refuses a remote that is a path traversal", () => {
    const result = PublishPushRun.buildArgv({ policy: POLICY, remote: "../../evil", branch: "loop/x" })
    expect(result.ok).toBe(false)
  })

  test("refuses a branch that would split the refspec or become an option", () => {
    for (const branch of ["-s", "loop/x:dev", "loop/x dev", "../evil", "loop/x;touch /tmp/pwned"]) {
      const result = PublishPushRun.buildArgv({ policy: POLICY, remote: "origin", branch })
      expect({ branch, ok: result.ok }).toEqual({ branch, ok: false })
    }
  })

  test("refuses an ungranted branch even when it is well formed", () => {
    expect(PublishPushRun.buildArgv({ policy: POLICY, remote: "origin", branch: "dev" }).ok).toBe(false)
    expect(PublishPushRun.buildArgv({ policy: POLICY, remote: "fork", branch: "loop/x" }).ok).toBe(false)
  })
})

describe.if(process.env.PUBLISH_POLICY_GIT === "1")("real git, scratch remote", () => {
  test("an allowed push advances only the granted branch", async () => {
    const { remote, work, ref } = await fixture()
    const devBefore = await ref("dev")
    await Bun.write(path.join(work, "y.txt"), "y")
    await git(work, ["add", "."])
    await git(work, ["commit", "-qm", "more loop work"])

    const outcome = await push(work, "origin", "loop/x")
    expect(outcome).toMatchObject({ code: 0 })
    expect(await ref("loop/x")).not.toBe(await ref("dev"))
    expect(await ref("dev")).toBe(devBefore)
  })

  test("a refused push leaves the remote untouched and runs nothing", async () => {
    const { remote, work, names } = await fixture()
    const before = await names()

    for (const branch of ["-s", "dev", "loop/x:dev"]) {
      const outcome = await push(work, "origin", branch)
      expect({ branch, refused: !("code" in outcome) }).toEqual({ branch, refused: true })
    }
    expect(await names()).toEqual(before)
  })

  test("the argv this module builds is one real git accepts", async () => {
    // The merge driver's argv was `git merge --no-edit squash dev <sha>`, which real
    // git rejects. This asserts the push argv is not merely plausible.
    const { work } = await fixture()
    const argv = PublishPushRun.buildArgv({ policy: POLICY, remote: "origin", branch: "loop/new" })
    if (!argv.ok) throw new Error("expected an argv")
    const out = await git(work, argv.argv)
    // Only the exit code: git writes progress to stderr on a successful push, so
    // asserting an empty stderr would be asserting something untrue.
    expect(out.code).toBe(0)
  })
})
describe("checks that are load-bearing only in a specific configuration", () => {
  test("a malformed remote the policy happens to grant is still refused", () => {
    // The remote grant check would otherwise be the only thing standing between a
    // typo'd policy and an option in the remote slot: a policy that granted
    // `--receive-pack=evil` passes the grant check, and only the name check refuses.
    const typo: PublishPolicy.Policy = { ...POLICY, push: { remotes: ["--receive-pack=evil"], branches: ["loop/*"] } }
    const result = PublishPushRun.buildArgv({ policy: typo, remote: "--receive-pack=evil", branch: "loop/x" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toContain("well-formed")
  })

  test("a path-traversal remote the policy happens to grant is still refused", () => {
    const typo: PublishPolicy.Policy = { ...POLICY, push: { remotes: ["../elsewhere"], branches: ["loop/*"] } }
    expect(PublishPushRun.buildArgv({ policy: typo, remote: "../elsewhere", branch: "loop/x" }).ok).toBe(false)
  })
})
