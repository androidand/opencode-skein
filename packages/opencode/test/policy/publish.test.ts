import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
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

/** Asserts a denial and hands back the reason, so a test can pin which check fired. */
async function denied(yaml: string | null, overrides: Partial<PublishPolicy.LoadDeps> = {}) {
  const result = await load("/repo", overrides, yaml)
  expect(result.status).toBe("denied")
  if (result.status !== "denied") throw new Error("unreachable")
  return result.reason
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
    expect(await denied(null)).toBe("no publish policy")
  })

  test("an unknown key is rejected, so the never-list cannot be relaxed by file", async () => {
    // The never-list is a code constant on purpose. A policy that could turn it
    // off would be a knob the model can edit, which is the thing the grant exists
    // to prevent, so this key must not be accepted and ignored.
    expect(await denied(`${VALID}\nneverList: []\n`)).toContain("neverList")
  })

  test("a scalar where a mapping belongs is rejected", async () => {
    const reason = await denied(VALID.replace('commit:\n  branches: ["loop/*", "feat/*"]', 'commit: "loop/*"'))
    expect(reason).toContain("commit")
  })

  test("a branch pattern matching the default branch is rejected", async () => {
    // Both a literal and a wildcard that covers it must fail: `*` is the shape
    // that would let a granted session push straight to the default branch.
    expect(await denied(VALID.replace('branches: ["loop/*", "feat/*"]', 'branches: ["dev"]'))).toContain("dev")
    expect(await denied(VALID.replace('branches: ["loop/*", "feat/*"]', 'branches: ["*"]'))).toContain("*")
  })

  test("a push pattern matching the default branch is rejected", async () => {
    expect(await denied(VALID.replace('branches: ["loop/*"]', 'branches: ["dev", "loop/*"]'))).toContain("dev")
  })

  test("the default branch is read, not assumed", async () => {
    // The same file grants or denies depending only on what the repo's default
    // branch is. A loader that hardcoded "dev" could not produce both outcomes,
    // which is the whole reason the value is injected.
    const grantsMain = VALID.replace('branches: ["loop/*", "feat/*"]', 'branches: ["loop/*", "main"]')
    expect((await load("/repo", { defaultBranch: Effect.succeed("dev") }, grantsMain)).status).toBe("granted")
    expect(await denied(grantsMain, { defaultBranch: Effect.succeed("main") })).toContain("main")
  })

  test("an unreadable default branch grants nothing", async () => {
    expect(
      await denied(VALID, { defaultBranch: Effect.fail(new Error("no origin/HEAD")) }),
    ).toContain("default branch")
  })

  test("a remote that does not point at the asserted repo is rejected", async () => {
    expect(
      await denied(VALID, { remoteUrl: () => Effect.succeed("git@github.com:someone-else/other.git") }),
    ).toContain("origin")
  })

  test("an unreadable remote configuration grants nothing", async () => {
    expect(await denied(VALID, { remoteUrl: () => Effect.fail(new Error("not a git repo")) })).toContain(
      "remote",
    )
  })

  test("a visibility that disagrees with the forge is rejected", async () => {
    expect(await denied(VALID, { visibility: () => Effect.succeed("private") })).toContain("visibility mismatch")
  })

  test("an unreachable forge grants nothing rather than assuming a match", async () => {
    // The dangerous direction is treating "could not check" as "checked and
    // fine". This reason string is deliberately distinct from the mismatch
    // reason so the two cannot be confused: with the unreachable branch removed,
    // the failure falls through and reports a mismatch instead.
    expect(await denied(VALID, { visibility: () => Effect.fail(new Error("offline")) })).toContain(
      "forge was unreachable",
    )
  })

  test("the public-content scan cannot be claimed for a private repo", async () => {
    const priv = VALID.replace("visibility: public", "visibility: private")
    expect(await denied(priv, { visibility: () => Effect.succeed("private") })).toContain("scan")
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