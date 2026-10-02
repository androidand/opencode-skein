import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { Permission } from "@/permission"
import { Process } from "@/util/process"
import { PublishPolicy } from "@/policy/publish-policy"

// The pattern matcher surprised us twice: a trailing `*` becomes an OPTIONAL group,
// and `-f` matched inside ordinary branch names. So this suite checks the thing that
// actually matters — whether a real remote's default branch moves — using real git
// against a scratch bare remote. The matcher decides; git is the witness.
//
// It is skipped unless PUBLISH_POLICY_GIT=1 because it shells out and creates
// repositories. Set it to run it.

const POLICY: PublishPolicy.Policy = {
  version: 1,
  repo: "example/repo",
  visibility: "private",
  commit: { branches: ["loop/*"] },
  push: { remotes: ["origin"], branches: ["loop/*"] },
  merge: { into: ["dev"], method: "squash", requires: ["gates", "review"], by: ["integrator"] },
}

// Real git, through the same Process helper the drivers use, so the test exercises
// the argv path rather than a shell.
const git = (cwd: string, args: string[]) => Process.text(["git", ...args], { cwd, nothrow: true })
const gitText = async (cwd: string, args: string[]) => (await git(cwd, args)).text.trim()

/**
 * A scratch remote with `dev` and `loop/x`, plus an UNPUSHED commit on local `dev`.
 * The unpushed commit is what makes the bare-refspec attack observable: without it
 * there is nothing to fast-forward and the push is a no-op.
 */
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "publish-git-"))
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

  // An unpushed commit on dev, so a bare `dev` refspec has something to publish.
  await g(["checkout", "-q", "dev"])
  await Bun.write(path.join(work, "c.txt"), "c")
  await g(["add", "."])
  await g(["commit", "-qm", "unpushed dev work"])
  await g(["checkout", "-q", "loop/x"])
  return { remote, work, readRemoteDev: () => gitText(remote, ["rev-parse", "dev"]) }
}

describe.if(process.env.PUBLISH_POLICY_GIT === "1")("real git, scratch remote", () => {
  test("the matcher refuses the bare default-branch refspec that git would honour", async () => {
    // First: prove the attack is real. Real git, real remote, local dev ahead.
    const { remote, work, readRemoteDev } = await fixture()
    const before = await readRemoteDev()
    await git(work, ["push", "origin", "loop/x", "dev"])
    expect(await readRemoteDev()).not.toBe(before)

    // Then: the same command, refused by the ruleset, leaves the remote alone.
    const after = await readRemoteDev()
    expect(Permission.evaluate("bash", "git push origin loop/x dev", PublishPolicy.sessionRules(POLICY, "dev")).action).toBe(
      "deny",
    )
    expect(await readRemoteDev()).toBe(after)
  })

  test("an allowed push moves the branch it was granted, and nothing else", async () => {
    const { remote, work, readRemoteDev } = await fixture()
    const devBefore = await readRemoteDev()
    await Bun.write(path.join(work, "y.txt"), "y")
    await git(work, ["add", "."])
    await git(work, ["commit", "-qm", "more loop work"])
    expect(Permission.evaluate("bash", "git push origin loop/x", PublishPolicy.sessionRules(POLICY, "dev")).action).toBe(
      "allow",
    )
    await git(work, ["push", "origin", "loop/x"])
    // The granted branch advanced...
    expect(await gitText(remote, ["rev-parse", "loop/x"])).not.toBe("")
    // ...and the default branch did not.
    expect(await readRemoteDev()).toBe(devBefore)
  })

  test("a branch name containing -f is still pushable", async () => {
    // The false positive I shipped and then caught: `*git push*-f*` refused
    // `loop/dev-fix`. Real git, because this is the case a regex-only test would
    // have kept lying about.
    const { remote, work, readRemoteDev } = await fixture()
    await git(work, ["checkout", "-q", "-b", "loop/dev-fix"])
    await Bun.write(path.join(work, "f.txt"), "f")
    await git(work, ["add", "."])
    await git(work, ["commit", "-qm", "fix work"])
    const devBefore = await readRemoteDev()
    expect(Permission.evaluate("bash", "git push origin loop/dev-fix", PublishPolicy.sessionRules(POLICY, "dev")).action).toBe(
      "allow",
    )
    await git(work, ["push", "origin", "loop/dev-fix"])
    expect(await readRemoteDev()).toBe(devBefore)
  })
})