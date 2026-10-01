export * as PublishDrivers from "./drivers"

import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { PublishPolicy } from "./publish-policy"

// Phase 3 of standing-publish-authority: the decisions the commit and push paths
// make before doing anything.
//
// These are pure functions over repo state rather than executors. Phase 4 is
// where they get wired to real commands, and keeping the decision separate is
// what lets the refusal cases be tested without a repository or a remote. Each
// returns an explicit refusal reason rather than a boolean, because a driver that
// says "no" without saying why produces a log nobody can act on.
//
// CALLERS: pass a policy from `PublishPolicy.loadNow`, never from
// `PublishPolicy.current`. The latter is cached and exists for the prompt path,
// where a stale answer costs a slightly wrong instruction. A driver's answer
// decides whether something is published, so it reads the full load at action
// time. `current` also keys on age rather than only on the file's mtime, because
// the loader's verdict depends on the forge and the remote as well as the file —
// see the note on TTLms in publish.ts.

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

// What the merge driver must be told before it acts. `reviewVerdict` is the
// recorded decision, and `reviewedSHA` is the commit that decision was made
// about — kept separate because "a review happened" and "the review covered this
// exact head" are different claims, and only the second one authorises a merge.
export interface MergeEvidence {
  readonly headSHA: string
  readonly gatesPassed: boolean
  readonly reviewVerdict?: { readonly verdict: "LGTM" | "NEEDS_WORK"; readonly sha: string }
  readonly ciPassed: boolean
  /** Non-empty when `git merge-base` produced unrelated histories. */
  readonly mergeBase?: string
}

/**
 * Whether a merge may proceed, and into which branch.
 *
 * Withheld from the model shell because it needs evidence, not because of
 * credentials: every condition here is a fact about the outside world that only
 * the driver can establish. A shell pattern cannot see whether CI is green or
 * whether a verdict covers the head being merged.
 *
 * Each condition is checked separately so the refusal says which one failed —
 * a merge driver that answers "no" without a reason produces a log nobody can
 * act on.
 */
export function mayMerge(input: {
  policy: PublishPolicy.Policy
  target: string
  evidence: MergeEvidence
}): Refusal {
  if (!input.policy.merge.into.includes(input.target))
    return {
      ok: false,
      reason: `merge target "${input.target}" is not granted (${input.policy.merge.into.join(", ")})`,
    }
  if (!input.evidence.mergeBase)
    return {
      ok: false,
      reason: "unrelated histories: git merge-base returned nothing, so the branch point is unknown — stop and ask a human",
    }
  if (input.evidence.reviewVerdict === undefined)
    return { ok: false, reason: "no recorded review verdict for this merge" }
  if (input.evidence.reviewVerdict.verdict !== "LGTM")
    return { ok: false, reason: `the recorded verdict is ${input.evidence.reviewVerdict.verdict}, not LGTM` }
  // The exact-SHA check is the point of keeping the verdict's own sha: a verdict
  // for an earlier commit does not cover the head about to be merged.
  if (input.evidence.reviewVerdict.sha !== input.evidence.headSHA)
    return {
      ok: false,
      reason: `the verdict covers ${input.evidence.reviewVerdict.sha} but the head is ${input.evidence.headSHA}`,
    }
  for (const kind of input.policy.merge.requires) {
    if (kind === "gates" && !input.evidence.gatesPassed)
      return { ok: false, reason: "the gates have not passed" }
    if (kind === "ci" && !input.evidence.ciPassed) return { ok: false, reason: "CI has not passed" }
    if (kind === "review") continue
  }
  return { ok: true }
}

/**
 * The argv for an allowed merge.
 *
 * An array, never a shell string, so no branch name can introduce a second
 * command. No `--no-verify`, no fast-forward flag: the policy's `method` decides,
 * and passing a flag the policy did not sanction would be the driver widening its
 * own grant.
 */
export function mergeArgv(input: { target: string; headSHA: string; method: PublishPolicy.Policy["merge"]["method"] }) {
  return ["merge", "--no-edit", input.method, input.target, input.headSHA]
}

/**
 * Known residual: `git add .` and a bare `git add` with no path stage the whole
 * tree, and no wildcard can separate them from an explicit `git add ./src/x.ts`.
 * The commit gate's dirty-tree check and the review diff both surface the
 * consequence, but neither prevents it. Recorded rather than papered over.
 */
export const implicitStagingResidual = "git add . / bare git add cannot be distinguished from an explicit path by pattern"