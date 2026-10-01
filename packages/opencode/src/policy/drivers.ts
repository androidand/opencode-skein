export * as PublishDrivers from "./drivers"

import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { PublishPolicy } from "./publish"

// Phase 3 of standing-publish-authority: the decisions the commit and push paths
// make before doing anything.
//
// These are pure functions over repo state rather than executors. Phase 4 is
// where they get wired to real commands, and keeping the decision separate is
// what lets the refusal cases be tested without a repository or a remote. Each
// returns an explicit refusal reason rather than a boolean, because a driver that
// says "no" without saying why produces a log nobody can act on.

// Unambiguous forms of staging everything. `git add .` is deliberately absent: a
// shell wildcard cannot tell it from `git add ./src/x.ts`, so denying the former
// would deny the latter. See the residual note on `implicitStagingResidual`.
const ImplicitStagingDenials: readonly string[] = [
  "*git add -A*",
  "*git add --all*",
  "*git commit -a *",
  "*git commit -am *",
  "*git commit --all *",
]

export type Refusal =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * Whether a commit is permitted right now.
 *
 * The derived allow covers the command *shape*; this covers the state the shell
 * cannot see. Both are needed — the allow says the session may commit, this says
 * where.
 */
export function mayCommit(input: {
  policy: PublishPolicy.Policy
  branch: string | undefined
  defaultBranch: string | undefined
}): Refusal {
  if (!input.branch) return { ok: false, reason: "the current branch could not be read, so no commit ceiling could be checked" }
  // Compared before the patterns: a grant that names the default branch never
  // reaches this function, but re-checking costs nothing and keeps the rule local.
  if (input.defaultBranch && input.branch === input.defaultBranch)
    return { ok: false, reason: `refusing to commit on the default branch "${input.branch}"` }
  const granted = input.policy.commit.branches.some((pattern) => Wildcard.match(input.branch!, pattern))
  if (!granted)
    return {
      ok: false,
      reason: `branch "${input.branch}" matches none of the granted commit patterns (${input.policy.commit.branches.join(", ")})`,
    }
  return { ok: true }
}

/**
 * Whether a push is permitted, and to where.
 *
 * The tracking check is the way-of-working rule made mechanical: check the remote
 * and the tracking branch before any push, because a branch with no upstream is
 * the shape that publishes somewhere nobody intended.
 */
export function mayPush(input: {
  policy: PublishPolicy.Policy
  branch: string | undefined
  upstream: string | undefined
  remote: string
}): Refusal {
  if (!input.branch) return { ok: false, reason: "the current branch could not be read" }
  if (!input.policy.push.remotes.includes(input.remote))
    return {
      ok: false,
      reason: `remote "${input.remote}" is not granted (${input.policy.push.remotes.join(", ")})`,
    }
  if (!input.policy.push.branches.some((pattern) => Wildcard.match(input.branch!, pattern)))
    return {
      ok: false,
      reason: `branch "${input.branch}" matches none of the granted push patterns (${input.policy.push.branches.join(", ")})`,
    }
  if (!input.upstream)
    return {
      ok: false,
      reason: `branch "${input.branch}" tracks nothing; a push with no upstream is not a push anyone authorized`,
    }
  const [upstreamRemote] = input.upstream.split("/")
  if (upstreamRemote !== input.remote)
    return { ok: false, reason: `branch tracks "${input.upstream}" but the push targets "${input.remote}"` }
  const upstreamBranch = input.upstream.slice(input.remote.length + 1)
  if (!input.policy.push.branches.some((pattern) => Wildcard.match(upstreamBranch, pattern)))
    return {
      ok: false,
      reason: `upstream branch "${upstreamBranch}" matches none of the granted push patterns`,
    }
  return { ok: true }
}

/**
 * The argv for a granted push.
 *
 * Built as an array and never as a shell string, so a branch or remote name
 * cannot smuggle in a second command. Refuses rather than returning argv for an
 * ungranted push, so the caller cannot skip the check by ignoring a boolean.
 */
export function pushArgv(input: { remote: string; branch: string }): string[] {
  return ["push", input.remote, `HEAD:refs/heads/${input.branch}`]
}

/** Whether a staging command names paths explicitly. */
export function stagesExplicitly(command: string): boolean {
  return !ImplicitStagingDenials.some((pattern) => Wildcard.match(command, pattern))
}

/**
 * Known residual: `git add .` and a bare `git add` with no path stage the whole
 * tree, and no wildcard can separate them from an explicit `git add ./src/x.ts`.
 * The commit gate's dirty-tree check and the review diff both surface the
 * consequence, but neither prevents it. Recorded rather than papered over.
 */
export const implicitStagingResidual = "git add . / bare git add cannot be distinguished from an explicit path by pattern"