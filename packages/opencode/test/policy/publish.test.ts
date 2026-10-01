import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import path from "path"
import { mkdir, mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import { Process } from "@/util/process"
import { Permission } from "@/permission"
import { PublishPolicy } from "@/policy/publish"

// Every test here asserts a denial, so each one is also a claim that the grant
// is not being handed out by accident. The suite is only worth anything if
// those denials would go red when the check is removed, which is why each one
// was run against a deliberately broken loader before being believed.

const REPO = "androidand/opencode-skein"

const VALID = `
version: 1
repo: androidand/opencode-skein
visibility: public
commit:
  branches: ["loop/*", "feat/*"]
push:
  remotes: [origin]
  branches: ["loop/*"]
merge:
  into: [dev]
  method: squash
  requires: [gates, review]
  by: [integrator]
scan: public-content
`

/**
 * Builds loader dependencies with everything agreeing by default, so a test
 * states only the one thing it is about. `overrides` replaces a single
 * dependency. `yaml: null` means no policy file at all, which is distinct from an
 * empty one — an absent file and an invalid file must both deny, but for
 * different reasons.
 */
function deps(overrides: Partial<PublishPolicy.LoadDeps> = {}, yaml: string | null = VALID) {
  return {
    visibility: () => Effect.succeed("public"),
    remoteUrl: () => Effect.succeed("git@github.com:androidand/opencode-skein.git"),
    defaultBranch: Effect.succeed("dev"),
    readFile: () => Effect.succeed(yaml ?? undefined),
    ...overrides,
  } satisfies PublishPolicy.LoadDeps
}

const load = (directory: string, overrides: Partial<PublishPolicy.LoadDeps> = {}, yaml: string | null = VALID) =>
  Effect.runPromise(PublishPolicy.load({ directory, deps: deps(overrides, yaml) }))

/** Asserts a denial and hands back the result, so a test can pin which check fired. */
async function denied(yaml: string | null, overrides: Partial<PublishPolicy.LoadDeps> = {}) {
  const result = await load("/repo", overrides, yaml)
  expect(result.status).toBe("denied")
  if (result.status !== "denied") throw new Error("unreachable")
  return result
}

/** Writes a policy into a scratch git repo, so the real dependency wiring runs. */
async function makeRepoWithPolicy(yaml: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "publish-policy-"))
  const git = (...args: string[]) => Process.text(["git", ...args], { cwd: dir, nothrow: true })
  await mkdir(path.join(dir, ".skein"), { recursive: true })
  await Bun.write(path.join(dir, ".skein", "publish-policy.yaml"), yaml)
  await git("init", "--quiet")
  await git("remote", "add", "origin", `git@github.com:${REPO}.git`)
  // origin/HEAD is what a clone sets; `remote set-head` is what makes it exist.
  await git("update-ref", "refs/remotes/origin/dev", "HEAD")
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev")
  return dir
}

describe("publish policy load", () => {
  test("grants a policy that passes every check", async () => {
    const result = await load("/repo")
    expect(result.status).toBe("granted")
    if (result.status !== "granted") throw new Error("unreachable")
    expect(result.policy.repo).toBe(REPO)
    expect(result.policy.merge.requires).toEqual(["gates", "review"])
    expect(result.source).toBe("/repo/.skein/publish-policy.yaml")
  })

  test("an absent file grants nothing", async () => {
    expect((await denied(null)).reason).toBe(PublishPolicy.Reason.absent)
  })

  test("an unknown key is rejected, so the never-list cannot be relaxed by file", async () => {
    // The never-list is a code constant on purpose. A policy that could turn it
    // off would be a knob the model can edit, which is the thing the grant exists
    // to prevent, so this key must not be accepted and ignored.
    expect((await denied(`${VALID}\nneverList: []\n`)).detail).toContain("neverList")
  })

  test("a scalar where a mapping belongs is rejected", async () => {
    const result = await denied(VALID.replace('commit:\n  branches: ["loop/*", "feat/*"]', 'commit: "loop/*"'))
    expect(result.reason).toBe(PublishPolicy.Reason.malformed)
    expect(result.detail).toContain("commit")
  })

  test("a branch pattern matching the default branch is rejected", async () => {
    // Both a literal and a wildcard that covers it must fail: `*` is the shape
    // that would let a granted session push straight to the default branch.
    const literal = await denied(VALID.replace('branches: ["loop/*", "feat/*"]', 'branches: ["dev"]'))
    expect(literal.reason).toBe(PublishPolicy.Reason.grantsDefaultBranch)
    expect(literal.detail).toContain("dev")
    const wildcard = await denied(VALID.replace('branches: ["loop/*", "feat/*"]', 'branches: ["*"]'))
    expect(wildcard.reason).toBe(PublishPolicy.Reason.grantsDefaultBranch)
    expect(wildcard.detail).toContain("*")
  })

  test("a push pattern matching the default branch is rejected", async () => {
    const result = await denied(VALID.replace('branches: ["loop/*"]', 'branches: ["dev", "loop/*"]'))
    expect(result.reason).toBe(PublishPolicy.Reason.grantsDefaultBranch)
    expect(result.detail).toContain("dev")
  })

  test("the default branch is read, not assumed", async () => {
    // The same file grants or denies depending only on what the repo's default
    // branch is. A loader that hardcoded "dev" could not produce both outcomes,
    // which is the whole reason the value is injected.
    const grantsMain = VALID.replace('branches: ["loop/*", "feat/*"]', 'branches: ["loop/*", "main"]')
    expect((await load("/repo", { defaultBranch: Effect.succeed("dev") }, grantsMain)).status).toBe("granted")
    expect((await denied(grantsMain, { defaultBranch: Effect.succeed("main") })).detail).toContain("main")
  })

  test("an undeterminable default branch grants nothing", async () => {
    // Neither origin/HEAD nor an upstream yields a name, so there is no ceiling
    // to check against and the guess is refused.
    const result = await denied(VALID, { defaultBranch: Effect.fail(new Error("no origin/HEAD")) })
    expect(result.reason).toBe(PublishPolicy.Reason.defaultBranchUnknown)
  })

  test("a remote that does not point at the asserted repo is rejected", async () => {
    const result = await denied(VALID, { remoteUrl: () => Effect.succeed("git@github.com:someone-else/other.git") })
    expect(result.reason).toBe(PublishPolicy.Reason.remoteRepoMismatch)
    expect(result.detail).toContain("origin")
  })

  test("an unreadable remote configuration grants nothing", async () => {
    const result = await denied(VALID, { remoteUrl: () => Effect.fail(new Error("not a git repo")) })
    expect(result.reason).toBe(PublishPolicy.Reason.remoteUnreadable)
  })

  test("a visibility that disagrees with the forge is rejected", async () => {
    const result = await denied(VALID, { visibility: () => Effect.succeed("private") })
    expect(result.reason).toBe(PublishPolicy.Reason.visibilityMismatch)
    expect(result.detail).toContain("private")
  })

  test("an unreachable forge grants nothing rather than assuming a match", async () => {
    // The dangerous direction is treating "could not check" as "checked and
    // fine". This reason is deliberately distinct from the mismatch reason, so
    // removing the unreachable branch cannot leave the test passing on the
    // fallback's message.
    const result = await denied(VALID, { visibility: () => Effect.fail(new Error("offline")) })
    expect(result.reason).toBe(PublishPolicy.Reason.forgeUnreachable)
  })

  test("the public-content scan cannot be claimed for a private repo", async () => {
    const priv = VALID.replace("visibility: public", "visibility: private")
    const result = await denied(priv, { visibility: () => Effect.succeed("private") })
    expect(result.reason).toBe(PublishPolicy.Reason.scanNeedsPublic)
  })
})

// The suite above injects every dependency, which is what makes each rejection
// deterministic and offline. That leaves the real `gh` call unexercised, so this
// one runs the actual binary. It is opt-in because it needs network and
// credentials: set PUBLISH_POLICY_LIVE=1 to include it.
//
// The assertion is deliberately about failing closed rather than about the
// answer. Visibility for a repo is a fact that can change and a machine state
// that can differ, so pinning "public" here would make a test fail for a reason
// that has nothing to do with this code. What must hold everywhere is that an
// answer comes back and is one of the two words the schema knows — or that the
// loader denies rather than guessing.
// The real kimi prompt's rule line, verbatim rather than paraphrased: the
// removal matches one exact sentence, so a fixture that merely resembles the file
// would pass whether or not the match still works.
const KIMI =
  "Git safety rules:\n- DO NOT run `git commit`, `git push`, `git reset`, `git rebase` and/or do any other git mutations unless explicitly asked to do so. Ask for confirmation each time when you need to do git mutations, even if the user has confirmed in earlier conversations.\n- Never force push."

describe("prompt application", () => {
  test("lifts the ask-each-time clause when a policy grants", () => {
    const applied = PublishPolicy.composeSystem([KIMI], POLICY)
    expect(applied).not.toContain("Ask for confirmation each time")
    // Only that sentence goes. The surrounding rule the user actually wrote
    // stays, so a grant does not quietly widen into "commit whenever".
    expect(applied).toContain("unless explicitly asked to do so")
    expect(applied).toContain("Never force push")
  })

  test("removes the clause without leaving doubled whitespace", () => {
    expect(PublishPolicy.composeSystem([KIMI], POLICY)).toContain("do so.\n- Never force push.")
  })

  test("appends the standing-authorization section", () => {
    expect(PublishPolicy.composeSystem([KIMI], POLICY)).toContain("Standing authorization from your user")
  })

  test("a prompt with no such clause is returned untouched", () => {
    const other = "You are a careful assistant."
    expect(PublishPolicy.composeSystem([other], POLICY)).toContain(other)
  })

  test("the section does not claim the branch ceiling is enforced for it", () => {
    // The derived allows gate command shapes, not the checked-out branch, so
    // promising branch safety here would be a claim the code cannot keep.
    expect(PublishPolicy.promptSection(POLICY)).toContain("Check the branch yourself before committing")
  })
})

describe("no policy means no change at all", () => {
  test("the composed system prompt is byte-for-byte the original", () => {
    for (const prompt of [KIMI, "You are a careful assistant.", ""]) {
      const before = [prompt, "extra system", undefined].filter((x) => x).join("\n")
      expect(PublishPolicy.composeSystem([prompt], undefined, "extra system", undefined)).toBe(before)
    }
  })

  test("an ungranted session keeps the ask-each-time clause", () => {
    expect(PublishPolicy.composeSystem([KIMI], undefined)).toContain("Ask for confirmation each time")
  })
})

describe.if(process.env.PUBLISH_POLICY_LIVE === "1")("live forge", () => {
  test("the real gh lookup either answers with a known visibility or denies", async () => {
    const deps = PublishPolicy.systemDeps({ directory: process.cwd() })
    const reported = await Effect.runPromise(
      deps.visibility(REPO).pipe(Effect.result),
    )
    if (Result.isFailure(reported)) return
    expect(["public", "private"]).toContain(reported.success)
  })

  test("the loader denies rather than granting when the forge cannot be asked", async () => {
    // Point the lookup at a repo that does not exist, so gh fails for a reason
    // unrelated to the network. The grant must not survive that.
    const deps = PublishPolicy.systemDeps({ directory: process.cwd() })
    const result = await Effect.runPromise(
      PublishPolicy.load({
        directory: await makeRepoWithPolicy(VALID),
        deps: { ...deps, visibility: (repo: string) => deps.visibility(`nonexistent-owner/${repo}`) },
      }),
    )
    expect(result.status).toBe("denied")
    if (result.status !== "denied") throw new Error("unreachable")
    expect(result.reason).toBe(PublishPolicy.Reason.forgeUnreachable)
  })
})

describe("never-list", () => {
  test("covers the publishing and exfiltration shapes", () => {
    for (const command of [
      "git push origin dev",
      "git -c core.hooksPath=/tmp/evil push",
      "FOO=1 git push",
      "/usr/bin/git push",
      "git tag v1",
      "git remote add evil https://example.com",
      "gh pr merge 12",
      "gh api -X DELETE /repos/a/b",
      "gh release create v1",
      "npm publish",
      "bun publish",
      "cargo publish",
      "ssh host git push",
      "scp -r . host:",
      "rsync -a . host:",
      "systemctl restart thing",
      "launchctl load x",
      "cat ~/.aws/credential",
      "git config credential.helper store",
      "deploy --prod",
    ])
      expect({ command, denied: PublishPolicy.denied(command) }).toEqual({ command, denied: true })
  })

  test("covers force-rewrite forms", () => {
    for (const command of ["git push --force origin dev", "git push origin dev --force-with-lease", "git reset --hard HEAD~1", "git push origin --delete dev"])
      expect({ command, denied: PublishPolicy.denied(command) }).toEqual({ command, denied: true })
  })

  test("does not deny ordinary work", () => {
    // A standing grant is where a false positive becomes permanent, so the
    // never-list has to be checked against the commands an agent actually runs.
    for (const command of [
      "git status --porcelain",
      "git add packages/opencode/src/policy/publish.ts",
      "git commit -m 'feat(policy): add publish policy'",
      "git log --oneline -10",
      "git diff HEAD",
      "bun test test/policy",
      "bun run typecheck",
      "git checkout -b loop/publish-policy",
    ])
      expect({ command, denied: PublishPolicy.denied(command) }).toEqual({ command, denied: false })
  })
})

const POLICY: PublishPolicy.Policy = {
  version: 1,
  repo: REPO,
  visibility: "public",
  commit: { branches: ["loop/*"] },
  push: { remotes: ["origin"], branches: ["loop/*"] },
  merge: { into: ["dev"], method: "squash", requires: ["gates", "review"], by: ["integrator"] },
  scan: "public-content",
}

describe("derived rules", () => {
  test("turns the granted commit shapes from ask into allow", () => {
    // The point of the grant: a session no longer has to ask about work its user
    // already authorized.
    for (const command of ["git add src/x.ts", "git commit -m 'feat: x'", "git checkout -b loop/x"]) {
      expect({ command, action: Permission.evaluate("bash", command, PublishPolicy.sessionRules(POLICY)).action }).toEqual(
        { command, action: "allow" },
      )
    }
  })

  test("a deny beats an allow because the never-list is layered last", () => {
    // `Permission.evaluate` resolves with findLast, so ordering is the entire
    // mechanism. Each command below matches BOTH an allow shape and a
    // never-list entry, which is the only situation in which the order changes
    // the answer — a command only the deny matches cannot tell you anything
    // about layering. `git commit -m "docs: run publish.ts"` is the realistic
    // case: an ordinary commit whose message happens to contain the words.
    for (const command of [
      "git commit -m 'docs: run publish.ts'",
      "git add script/release/notes.md",
      "git commit -m 'chore: touch credential docs'",
    ])
      expect({ command, action: Permission.evaluate("bash", command, PublishPolicy.sessionRules(POLICY)).action }).toEqual(
        { command, action: "deny" },
      )
  })

  test("the same commands are allowed when the layers are reversed", () => {
    // The control for the test above. If this stops producing "allow" then the
    // deny verdicts were never coming from the ordering, and the test above was
    // proving nothing.
    const reversed = [...PublishPolicy.denyRules(), ...PublishPolicy.deriveRules(POLICY)]
    for (const command of ["git commit -m 'docs: run publish.ts'"])
      expect({ command, action: Permission.evaluate("bash", command, reversed).action }).toEqual({
        command,
        action: "allow",
      })
  })

  test("no emitted allow is driver-executed or never-list denied", () => {
    // The property, stated once. `deriveRules` enforces it twice — by name via
    // DriverOnly, and by asking the never-list — and on today's lists those two
    // filters overlap, so neither can be isolated by mutating it alone. Asserting
    // the property is what actually holds; the redundancy is deliberate.
    const emitted = PublishPolicy.deriveRules(POLICY).map((rule) => rule.pattern)
    for (const pattern of emitted) {
      expect({ pattern, driverOnly: /push|merge|tag/.test(pattern), denied: PublishPolicy.denied(pattern) }).toEqual({
        pattern,
        driverOnly: false,
        denied: false,
      })
    }
  })

  test("the emitted allows are exactly the local commit shapes", () => {
    // Pins the other direction too: a filter that removed everything would also
    // satisfy the property above, and a grant that permits nothing is useless.
    expect(PublishPolicy.deriveRules(POLICY).map((rule) => rule.pattern)).toEqual([
      "git add*",
      "git commit*",
      "git checkout -b*",
      "git switch -c*",
      "git stash list",
    ])
  })

  test("force-push variants stay denied", () => {
    // `--force`, the `-f` short form, the lease variant and the `+ref` form all
    // reach a push, which the never-list refuses outright. `-f` cannot be caught
    // by a bare `*-f*` pattern — that would deny nearly every command — so this
    // holds because the push itself is refused, not because a flag is matched.
    for (const command of [
      "git push --force origin dev",
      "git push -f origin dev",
      "git push --force-with-lease origin dev",
      "git push origin +refs/heads/dev",
      "git -c core.hooksPath=/tmp/x push --force origin dev",
      "FOO=1 git push -f",
      "git push --force-if-includes origin dev",
    ])
      expect({ command, action: Permission.evaluate("bash", command, PublishPolicy.sessionRules(POLICY)).action }).toEqual(
        { command, action: "deny" },
      )
  })

  test("force-rewrite shapes are denied on their own, not only via push", () => {
    // `reset --hard` discards work and never mentions a push.
    expect(PublishPolicy.denied("git reset --hard HEAD~1")).toBe(true)
    expect(PublishPolicy.denied("git push origin --delete dev")).toBe(true)
  })
})

describe("prompt section", () => {
  test("states the grant and the standing refusals", () => {
    const section = PublishPolicy.promptSection(POLICY)
    expect(section).toContain("Standing authorization from your user for androidand/opencode-skein")
    expect(section).toContain("loop/*")
    expect(section).toContain("driver-executed")
    expect(section).toContain("never covers history rewrites")
  })

  test("mentions the public-content scan only when the policy claims one", () => {
    expect(PublishPolicy.promptSection(POLICY)).toContain("scanned for private content")
    expect(PublishPolicy.promptSection({ ...POLICY, scan: undefined })).not.toContain("scanned for private content")
  })

  test("tells the model to ask rather than run a push itself", () => {
    expect(PublishPolicy.promptSection(POLICY)).toContain("do not run it yourself")
  })
})