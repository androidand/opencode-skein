export * as PublishMerge from "./merge-run"

import { spawn } from "child_process"
import { mkdtemp, mkdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { join, isAbsolute } from "path"
import { PublishDrivers } from "./drivers"
import type { PublishPolicy } from "./publish-policy"

// The merge driver: the one place a change reaches the default branch.
//
// It exists as an executor, not only a decision, because the decision alone cannot
// be right. The first version produced `git merge --no-edit squash dev <sha>`, which
// git rejects ("squash - not something we can merge") — a command that was only ever
// compared as a string. Everything here is therefore tested against real git
// repositories, and each step is shaped by something that went wrong or could:
//
//   - It merges onto the REMOTE tip, fetched now, never onto a local branch. A local
//     `dev` can be stale, diverged, or carry history that was never meant to be
//     published, and merging onto it would publish all of it.
//   - Arguments are exact: a full 40-character SHA and a validated ref name, so
//     nothing in an argument list can be read by git as an option.
//   - It recomputes the merge base instead of trusting the caller's, and refuses a
//     head that is already contained in the target.
//   - It refuses unless the target tip is already contained in the head. Review and CI
//     are evidence about the HEAD; if the target has moved on, the merge result is a
//     different tree that nobody reviewed or tested. With the tip contained, the result
//     tree is identical to the head tree, and the driver asserts that after merging.
//   - The merge happens in a throwaway worktree, so it never touches a checkout
//     someone else is working in.
//   - Publication is `git push <remote> <sha>:refs/heads/<target>` with no force.
//     If the remote moved since the fetch, git refuses, and so do we; nothing is
//     overwritten.
//   - One merge per target at a time, by an atomic lock directory.
//   - No `--no-verify`. The push runs from the REAL checkout, not the throwaway worktree:
//     this repo sets `core.hooksPath` to the relative `.husky/_`, which does not exist in
//     a fresh worktree, so git would silently skip the pre-push hook there. (The hook
//     then runs against the checkout's own state; that is the repository's policy to
//     express, and a refusal fails closed.)
//   - `rebase` is refused rather than approximated. A wrong implementation of the
//     one irreversible action is worse than none.

export type Evidence = PublishDrivers.MergeEvidence

export type GitResult = { code: number; stdout: string; stderr: string }
export type Git = (args: string[], cwd: string) => Promise<GitResult>

export const realGit: Git = (args, cwd) =>
  new Promise((resolve) => {
    // No shell: an argument is an argument.
    const child = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: String(error) }))
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })

export type MergeOutcome =
  | { ok: true; merged: string; previous: string; published: boolean }
  | { ok: false; stage: Stage; reason: string }

export type Stage =
  | "decision"
  | "lock"
  | "fetch"
  | "verify"
  | "worktree"
  | "merge"
  | "commit"
  | "push"

const refuse = (stage: Stage, reason: string): MergeOutcome => ({ ok: false, stage, reason })
const first = (text: string) => text.trim().split("\n")[0] ?? ""

export async function runMerge(input: {
  /** The repository's working directory (any checkout of it). */
  repo: string
  policy: PublishPolicy.Policy
  target: string
  remote: string
  actor: string
  evidence: PublishDrivers.MergeEvidence
  /** Skip publication and leave the result in the throwaway worktree's object store only. */
  dryRun?: boolean
  git?: Git
}): Promise<MergeOutcome> {
  const git = input.git ?? realGit
  const { repo, target, remote, evidence } = input
  const head = evidence.headSHA

  // The decision, with the same inputs the caller will log. The remote must be one
  // the policy was verified against (the loader matched its URL to `repo`).
  const decision = PublishDrivers.mayMerge({ policy: input.policy, target, actor: input.actor, evidence })
  if (!decision.ok) return refuse("decision", decision.reason)
  if (!PublishDrivers.isSafeRefName(remote) || !input.policy.push.remotes.includes(remote))
    return refuse("decision", `remote "${remote}" is not one the policy grants (${input.policy.push.remotes.join(", ")})`)
  if (input.policy.merge.method === "rebase")
    return refuse("decision", "the rebase merge method is not supported; use squash or merge")

  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo)
  if (common.code !== 0 || !isAbsolute(first(common.stdout))) return refuse("verify", `not a git repository: ${first(common.stderr)}`)
  const lockDir = join(first(common.stdout), `skein-merge-${target.replace(/\//g, "_")}.lock`)

  // Atomic: mkdir either creates the lock or fails because someone else holds it.
  try {
    await mkdir(lockDir)
  } catch {
    return refuse("lock", `another merge into "${target}" is in progress (${lockDir})`)
  }
  let worktree: string | undefined
  try {
    const fetched = await git(["fetch", "--no-tags", "--quiet", remote, `+refs/heads/${target}:refs/remotes/${remote}/${target}`], repo)
    if (fetched.code !== 0) return refuse("fetch", `could not fetch ${remote}/${target}: ${first(fetched.stderr)}`)
    const tip = first((await git(["rev-parse", "--verify", `refs/remotes/${remote}/${target}^{commit}`], repo)).stdout)
    if (!PublishDrivers.isFullSHA(tip)) return refuse("fetch", `${remote}/${target} did not resolve to a commit`)

    // The head must exist locally as a commit — a SHA, not a name that could move.
    const exists = await git(["cat-file", "-e", `${head}^{commit}`], repo)
    if (exists.code !== 0) return refuse("verify", `commit ${head} is not in this repository`)

    // Already in the target? Then there is nothing to merge, and merging again would
    // only add an empty commit that looks like work.
    const contained = await git(["merge-base", "--is-ancestor", head, tip], repo)
    if (contained.code === 0) return refuse("verify", `${head} is already contained in ${remote}/${target}`)

    // Recompute the branch point. Trusting the caller's would let a stale or invented
    // value stand in for the check it exists to be.
    const base = first((await git(["merge-base", tip, head], repo)).stdout)
    if (!PublishDrivers.isFullSHA(base)) return refuse("verify", "unrelated histories: no common ancestor with the target — stop and ask a human")
    if (base !== evidence.mergeBase) return refuse("verify", `the evidence names merge base ${evidence.mergeBase} but it is ${base}: the evidence is stale`)
    if (base !== tip)
      return refuse(
        "verify",
        `${remote}/${target} has moved since the branch point (${base.slice(0, 12)} -> ${tip.slice(0, 12)}): update the branch onto the current ${target} and have it reviewed again — the evidence covers the head, and merging now would produce a tree nobody reviewed`,
      )

    const dir = await mkdtemp(join(tmpdir(), "skein-merge-"))
    worktree = dir
    const added = await git(["worktree", "add", "--detach", dir, tip], repo)
    if (added.code !== 0) return refuse("worktree", `could not create a worktree: ${first(added.stderr)}`)

    const label = `${head.slice(0, 12)} into ${target}`
    if (input.policy.merge.method === "squash") {
      const squashed = await git(["merge", "--squash", head], dir)
      if (squashed.code !== 0) return refuse("merge", `conflicts or merge failure (${first(squashed.stderr) || first(squashed.stdout)})`)
      const committed = await git(["commit", "--quiet", "-m", `Merge ${label} (squash)`], dir)
      if (committed.code !== 0) return refuse("commit", `commit refused: ${first(committed.stderr) || first(committed.stdout)}`)
    } else {
      const merged = await git(["merge", "--no-ff", "--no-edit", "-m", `Merge ${label}`, head], dir)
      if (merged.code !== 0) return refuse("merge", `conflicts or merge failure (${first(merged.stderr) || first(merged.stdout)})`)
    }
    const result = first((await git(["rev-parse", "HEAD"], dir)).stdout)
    if (!PublishDrivers.isFullSHA(result) || result === tip) return refuse("commit", "the merge produced no new commit")
    // The evidence is about the head's tree. If the result's tree differs, something other than
    // the reviewed change is about to be published.
    const resultTree = first((await git(["rev-parse", `${result}^{tree}`], dir)).stdout)
    const headTree = first((await git(["rev-parse", `${head}^{tree}`], repo)).stdout)
    if (!resultTree || resultTree !== headTree) return refuse("commit", `the merge result's tree (${resultTree.slice(0, 12)}) is not the reviewed head's tree (${headTree.slice(0, 12)})`)

    if (input.dryRun) return { ok: true, merged: result, previous: tip, published: false }

    // No force. A remote that moved since the fetch makes this a non-fast-forward, which
    // git refuses — the right outcome, because the evidence was gathered against `tip`.
    // From `repo`, not the worktree: see the note on hooks above. The object exists in the shared store.
    const pushed = await git(["push", "--quiet", remote, `${result}:refs/heads/${target}`], repo)
    if (pushed.code !== 0) return refuse("push", `the remote refused the merge (${first(pushed.stderr)})`)
    return { ok: true, merged: result, previous: tip, published: true }
  } finally {
    if (worktree) {
      await git(["worktree", "remove", "--force", worktree], repo)
      await rm(worktree, { recursive: true, force: true })
    }
    await rm(lockDir, { recursive: true, force: true })
  }
}
