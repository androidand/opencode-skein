import { describe, expect, test } from "bun:test"
import { PublishPolicy } from "@/policy/publish"
import { PublishDrivers } from "@/policy/drivers"

const POLICY: PublishPolicy.Policy = {
  version: 1,
  repo: "androidand/opencode-skein",
  visibility: "public",
  commit: { branches: ["loop/*", "feat/*"] },
  push: { remotes: ["origin"], branches: ["loop/*"] },
  merge: { into: ["dev"], method: "squash", requires: ["gates", "review"], by: ["integrator"] },
  scan: "public-content",
}

describe("commit gate", () => {
  test("permits a granted branch", () => {
    for (const branch of ["loop/publish-policy", "feat/x"])
      expect(PublishDrivers.mayCommit({ policy: POLICY, branch, defaultBranch: "dev" })).toEqual({ ok: true })
  })

  test("refuses the default branch even when a pattern would match it", () => {
    // The load-time check already rejects such a policy, so this branch is
    // unreachable in production — but the gate that stops a commit must not
    // depend on the loader having run.
    const wide: PublishPolicy.Policy = { ...POLICY, commit: { branches: ["*"] } }
    expect(PublishDrivers.mayCommit({ policy: wide, branch: "dev", defaultBranch: "dev" })).toEqual({
      ok: false,
      reason: 'refusing to commit on the default branch "dev"',
    })
  })

  test("refuses a branch outside the granted patterns", () => {
    const result = PublishDrivers.mayCommit({ policy: POLICY, branch: "main", defaultBranch: "dev" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toContain("main")
    expect(result.reason).toContain("loop/*")
  })

  test("refuses when the branch cannot be read", () => {
    // "I could not check" must not read as "allowed".
    const result = PublishDrivers.mayCommit({ policy: POLICY, branch: undefined, defaultBranch: "dev" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toContain("could not be read")
  })
})

describe("push gate", () => {
  const base = { policy: POLICY, branch: "loop/x", upstream: "origin/loop/x", remote: "origin" }

  test("permits a granted branch tracking the granted remote", () => {
    expect(PublishDrivers.mayPush(base)).toEqual({ ok: true })
  })

  test("refuses an ungranted remote", () => {
    // Self-consistent: the upstream names the same ungranted remote and the branch
    // is otherwise fully granted, so the ONLY thing refusing this is the remote
    // grant check. With an upstream pointing at `origin` instead, a later check
    // would refuse anyway and this test would pass for the wrong reason.
    const result = PublishDrivers.mayPush({ ...base, remote: "fork", upstream: "fork/loop/x" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toContain("fork")
    expect(result.reason).toContain("not granted")
  })

  test("refuses a branch that tracks nothing", () => {
    // The way-of-working rule about checking tracking before a push, made
    // mechanical: an upstream-less branch is the shape that publishes somewhere
    // nobody authorized.
    const result = PublishDrivers.mayPush({ ...base, upstream: undefined })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toContain("tracks nothing")
  })

  test("refuses when the upstream remote differs from the push target", () => {
    const result = PublishDrivers.mayPush({ ...base, upstream: "fork/loop/x", remote: "origin" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toContain("fork/loop/x")
  })

  test("refuses an upstream branch outside the granted patterns", () => {
    // Local branch looks fine; where it would land does not.
    const result = PublishDrivers.mayPush({ ...base, branch: "feat/x", upstream: "origin/feat/x" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toContain("feat/x")
  })

  test("refuses a commit-only branch", () => {
    expect(PublishDrivers.mayPush({ ...base, branch: "feat/x", upstream: "origin/feat/x" }).ok).toBe(false)
  })
})

describe("push argv", () => {
  test("is an argv, never a shell string", () => {
    expect(PublishDrivers.pushArgv({ remote: "origin", branch: "loop/x" })).toEqual([
      "push",
      "origin",
      "HEAD:refs/heads/loop/x",
    ])
  })

  test("a branch name cannot smuggle in a second command", () => {
    // As argv there is no shell to re-parse; this asserts the shape that keeps it
    // that way rather than testing an escaping routine that does not exist.
    const argv = PublishDrivers.pushArgv({ remote: "origin", branch: "loop/x; rm -rf /" })
    expect(argv).toHaveLength(3)
    expect(argv[2]).toBe("HEAD:refs/heads/loop/x; rm -rf /")
  })
})

describe("explicit staging", () => {
  test("accepts explicitly named paths", () => {
    for (const command of [
      "git add src/policy/drivers.ts",
      "git add src/a.ts src/b.ts",
      "git commit -m 'feat(policy): add drivers'",
      "git commit src/policy/drivers.ts -m 'x'",
    ])
      expect({ command, explicit: PublishDrivers.stagesExplicitly(command) }).toEqual({ command, explicit: true })
  })

  test("refuses the unambiguous whole-tree forms", () => {
    for (const command of [
      "git add -A",
      "git add --all",
      "git add -A .",
      "git commit -a -m 'x'",
      "git commit -am 'x'",
      "git commit --all -m 'x'",
    ])
      expect({ command, explicit: PublishDrivers.stagesExplicitly(command) }).toEqual({ command, explicit: false })
  })

  test("records the residual it cannot catch", () => {
    // Stated rather than asserted into existence: `git add .` and a bare
    // `git add` stage everything, and no wildcard separates them from an
    // explicit path. The test pins that we know, not that it is solved.
    expect(PublishDrivers.stagesExplicitly("git add .")).toBe(true)
    expect(PublishDrivers.implicitStagingResidual).toContain("git add .")
  })
})