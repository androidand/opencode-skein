import { describe, expect, test } from "bun:test"
import { PublishPolicy } from "@/policy/publish-policy"
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
describe("merge gate", () => {
  const HEAD = "a".repeat(40)
  const BASE = "b".repeat(40)
  const OLD = "c".repeat(40)
  const ok = {
    headSHA: HEAD,
    gates: { passed: true, sha: HEAD },
    ci: { passed: true, sha: HEAD },
    reviewVerdict: { verdict: "LGTM" as const, sha: HEAD },
    mergeBase: BASE,
  }
  const may = (over: Partial<Parameters<typeof PublishDrivers.mayMerge>[0]> = {}) =>
    PublishDrivers.mayMerge({ policy: POLICY, target: "dev", actor: "integrator", evidence: ok, ...over })
  const refusal = (r: ReturnType<typeof may>) => (r.ok ? "" : r.reason)

  test("permits a merge with evidence covering the exact head", () => {
    expect(may()).toEqual({ ok: true })
  })

  describe("review authenticity", () => {
    const verdictBy = (reviewerSessionID?: string, independence: "independent" | "same-model" = "independent") => ({
      ...ok,
      reviewVerdict: { verdict: "LGTM" as const, sha: HEAD, independence, reviewerSessionID },
    })

    test("refuses a verdict written by the author's own session", () => {
      expect(refusal(may({ evidence: verdictBy("ses_author"), authorSessionID: "ses_author" }))).toContain("author's own session")
    })

    test("accepts a verdict from a different session", () => {
      expect(may({ evidence: verdictBy("ses_reviewer"), authorSessionID: "ses_author" })).toEqual({ ok: true })
    })

    test("refuses a verdict that does not say who reviewed it once the author is known", () => {
      expect(refusal(may({ evidence: verdictBy(undefined), authorSessionID: "ses_author" }))).toContain("which session reviewed")
      expect(refusal(may({ evidence: verdictBy(""), authorSessionID: "ses_author" }))).toContain("which session reviewed")
    })

    test("without an author given the check does not apply (callers that predate it)", () => {
      expect(may({ evidence: verdictBy("ses_author") })).toEqual({ ok: true })
    })

    test("requireIndependent refuses a same-model review and an unrecorded one, and accepts an independent one", () => {
      expect(refusal(may({ evidence: verdictBy("r", "same-model"), requireIndependent: true }))).toContain("independent review is required")
      expect(refusal(may({ requireIndependent: true }))).toContain("unrecorded")
      expect(may({ evidence: verdictBy("r"), requireIndependent: true })).toEqual({ ok: true })
    })
  })

  test("refuses an actor the policy does not list", () => {
    expect(refusal(may({ actor: "model" }))).toContain("may not merge")
  })

  test("refuses a target the policy does not grant", () => {
    expect(refusal(may({ target: "main" }))).toContain("not granted")
  })

  test("refuses a target that git would read as an option, even when the policy lists it", () => {
    const policy = { ...POLICY, merge: { ...POLICY.merge, into: ["-s"] } }
    expect(refusal(may({ policy, target: "-s" }))).toContain("not a safe branch name")
  })

  test("refuses a head that is not a full commit id", () => {
    const evidence = { ...ok, headSHA: "abc123", reviewVerdict: { verdict: "LGTM" as const, sha: "abc123" }, gates: { passed: true, sha: "abc123" }, ci: { passed: true, sha: "abc123" } }
    expect(refusal(may({ evidence }))).toContain("full 40-character")
  })

  test("refuses unrelated histories", () => {
    expect(refusal(may({ evidence: { ...ok, mergeBase: undefined } }))).toContain("unrelated histories")
  })

  test("refuses when no verdict is recorded, and for a NEEDS_WORK verdict", () => {
    expect(refusal(may({ evidence: { ...ok, reviewVerdict: undefined } }))).toContain("no recorded review verdict")
    expect(refusal(may({ evidence: { ...ok, reviewVerdict: { verdict: "NEEDS_WORK", sha: HEAD } } }))).toContain("not LGTM")
  })

  test("refuses a verdict for an earlier commit", () => {
    expect(refusal(may({ evidence: { ...ok, reviewVerdict: { verdict: "LGTM", sha: OLD } } }))).toContain("verdict covers")
  })

  test("a required evidence kind that is missing, failed, or about another commit refuses", () => {
    // This file's POLICY does not require CI, so use one that requires everything.
    const all: PublishPolicy.Policy = { ...POLICY, merge: { ...POLICY.merge, requires: ["gates", "review", "ci"] } }
    expect(refusal(may({ policy: all, evidence: { ...ok, gates: undefined } }))).toContain("no recorded result")
    expect(refusal(may({ policy: all, evidence: { ...ok, ci: undefined } }))).toContain("no recorded result")
    expect(refusal(may({ policy: all, evidence: { ...ok, gates: { passed: false, sha: HEAD } } }))).toContain("did not pass")
    expect(refusal(may({ policy: all, evidence: { ...ok, ci: { passed: false, sha: HEAD } } }))).toContain("did not pass")
    expect(refusal(may({ policy: all, evidence: { ...ok, gates: { passed: true, sha: OLD } } }))).toContain("ran on")
    expect(refusal(may({ policy: all, evidence: { ...ok, ci: { passed: true, sha: OLD } } }))).toContain("ran on")
  })

  test("checks only the evidence kinds the policy requires, but never merges without a verdict", () => {
    const noCI: PublishPolicy.Policy = { ...POLICY, merge: { ...POLICY.merge, requires: ["gates", "review"] } }
    expect(may({ policy: noCI, evidence: { ...ok, ci: { passed: false, sha: OLD } } })).toEqual({ ok: true })
    const noReview: PublishPolicy.Policy = { ...POLICY, merge: { ...POLICY.merge, requires: ["gates"] } }
    expect(refusal(may({ policy: noReview, evidence: { ...ok, reviewVerdict: undefined } }))).toContain("no recorded review verdict")
  })
})

describe("push destination ref", () => {
  const granted = ["loop/*"]

  test("accepts a bare branch inside the grant", () => {
    expect(PublishDrivers.pushDestinationRef({ refspec: "loop/x", granted })).toEqual({ ok: true })
    expect(PublishDrivers.pushDestinationRef({ refspec: "refs/heads/loop/x", granted })).toEqual({ ok: true })
  })

  test("refuses a destination outside the grant", () => {
    // The case the shell pattern cannot see: the command mentions only loop/x.
    for (const refspec of ["loop/x:dev", "loop/x:refs/heads/dev", "main", "loop/x:feat/y"])
      expect({ refspec, result: PublishDrivers.pushDestinationRef({ refspec, granted }) }).toEqual({
        refspec,
        result: { ok: false, reason: expect.stringContaining("granted push patterns") },
      })
  })

  test("refuses a forced refspec", () => {
    for (const refspec of ["+refs/heads/loop/x", "+loop/x"])
      expect(PublishDrivers.pushDestinationRef({ refspec, granted }).ok).toBe(false)
  })

  test("refuses a destination that is not a branch", () => {
    for (const refspec of ["loop/x:refs/tags/v1", "refs/tags/v1"])
      expect(PublishDrivers.pushDestinationRef({ refspec, granted }).ok).toBe(false)
  })

  test("refuses a refspec naming no destination", () => {
    expect(PublishDrivers.pushDestinationRef({ refspec: "loop/x:", granted }).ok).toBe(false)
  })
})
