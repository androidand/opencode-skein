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

// What the merge driver must be told before it acts. Every piece of evidence
// carries the commit it is about, because "the gates passed", "CI passed" and "a
// review happened" are all claims about SOME commit, and only a claim about the
// exact head being merged authorises anything. A bare boolean cannot say which
// commit it covers: gates that passed on an earlier head would read as passing now.
export interface MergeEvidence {
  readonly headSHA: string
  readonly gates?: { readonly passed: boolean; readonly sha: string }
  readonly ci?: { readonly passed: boolean; readonly sha: string }
  /**
   * `independence` is carried, not yet enforced: whether a same-model review
   * satisfies the review requirement is a policy knob, and it cannot be decided
   * from data that was not recorded. Absent on evidence assembled by callers that
   * predate the field.
   */
  readonly reviewVerdict?: {
    readonly verdict: "LGTM" | "NEEDS_WORK"
    readonly sha: string
    readonly independence?: "independent" | "same-model"
    /** Who wrote the verdict, as the record claims. Compared with the author's session by `mayMerge`. */
    readonly reviewerSessionID?: string
  }
  /** The merge base of target and head, as the caller computed it. The executor recomputes it. */
  readonly mergeBase?: string
}

/** A full object id. Abbreviations are refused: two commits can share a prefix, and a verdict for one must not cover the other. */
const FULL_SHA = /^[0-9a-f]{40}$/

export function isFullSHA(value: string): boolean {
  return FULL_SHA.test(value)
}

/**
 * A branch or remote name safe to put in an argument list. A leading `-` would be
 * read by git as an option (`-s ours` records a merge while discarding the
 * branch's changes), and the forbidden characters are the ones git itself refuses
 * in ref names plus whitespace, which would split one argument into two.
 */
export function isSafeRefName(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".lock") || value.endsWith("."))
    return false
  if (value.includes("..") || value.includes("//") || value.includes("@{")) return false
  return /^[A-Za-z0-9._/-]+$/.test(value)
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
 * act on. `actor` is who is asking; the policy's `merge.by` lists who may.
 */
export function mayMerge(input: {
  policy: PublishPolicy.Policy
  target: string
  actor: string
  evidence: MergeEvidence
  /**
   * The session that wrote the change. When given, the verdict must name a
   * different reviewer session: the record sits in the author's working tree, so
   * without this an author's own LGTM would be indistinguishable from a review.
   */
  authorSessionID?: string
  /** Refuse a verdict whose `independence` is not "independent" (a same-model review). */
  requireIndependent?: boolean
}): Refusal {
  if (!input.policy.merge.by.includes(input.actor))
    return { ok: false, reason: `"${input.actor}" may not merge (${input.policy.merge.by.join(", ")})` }
  if (!isSafeRefName(input.target)) return { ok: false, reason: `"${input.target}" is not a safe branch name` }
  if (!input.policy.merge.into.includes(input.target))
    return {
      ok: false,
      reason: `merge target "${input.target}" is not granted (${input.policy.merge.into.join(", ")})`,
    }
  if (!isFullSHA(input.evidence.headSHA))
    return { ok: false, reason: `head "${input.evidence.headSHA}" is not a full 40-character commit id` }
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
  const verdict = input.evidence.reviewVerdict
  if (input.authorSessionID !== undefined) {
    if (!verdict.reviewerSessionID)
      return { ok: false, reason: "the verdict does not say which session reviewed it, so it cannot be told apart from the author's own" }
    if (verdict.reviewerSessionID === input.authorSessionID)
      return { ok: false, reason: "the verdict was written by the author's own session, not by a reviewer" }
  }
  if (input.requireIndependent && verdict.independence !== "independent")
    return { ok: false, reason: `the review is ${verdict.independence ?? "of unrecorded independence"}, and an independent review is required` }
  for (const kind of input.policy.merge.requires) {
    if (kind === "review") continue // checked above, unconditionally: a merge never goes without a verdict
    const item = kind === "gates" ? input.evidence.gates : input.evidence.ci
    const label = kind === "gates" ? "the gates" : "CI"
    if (item === undefined) return { ok: false, reason: `${label}: no recorded result` }
    if (item.sha !== input.evidence.headSHA)
      return { ok: false, reason: `${label} ran on ${item.sha} but the head is ${input.evidence.headSHA}` }
    if (!item.passed) return { ok: false, reason: `${label} did not pass` }
  }
  return { ok: true }
}

/**
 * Whether a push refspec's DESTINATION is inside the grant.
 *
 * The shell allow cannot do this job. `*` in a granted branch pattern compiles to
 * `.*`, which matches colons and spaces, so `git push origin loop/x:dev` matches an
 * allow for `git push origin loop/*` — the push lands on the remote's `dev` while
 * the pattern appears to name only a loop branch. Parsing the refspec is the only
 * way to ask the question that matters: not "does this command look like the grant"
 * but "which ref on the remote does this write".
 *
 * A refspec is `src[:dst]`. With no colon, git pushes to the branch of the same
 * name, so the destination is the source. Anything with a leading `+` is a forced
 * update and is refused here as well as by the shell pattern.
 */
export function pushDestinationRef(input: { refspec: string; granted: readonly string[] }): Refusal {
  const forced = input.refspec.startsWith("+")
  const spec = forced ? input.refspec.slice(1) : input.refspec
  const destination = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec
  if (!destination)
    return { ok: false, reason: `refspec "${input.refspec}" names no destination ref` }
  if (forced) return { ok: false, reason: `refspec "${input.refspec}" forces an update` }
  const branch = destination.startsWith("refs/heads/") ? destination.slice("refs/heads/".length) : destination
  // Anything addressed under refs/ that is not refs/heads/ is a tag or an arbitrary
  // ref, which no push grant covers.
  if (destination.startsWith("refs/") && !destination.startsWith("refs/heads/"))
    return { ok: false, reason: `destination "${destination}" is not a branch under refs/heads` }
  if (!input.granted.some((pattern) => Wildcard.match(branch, pattern)))
    return {
      ok: false,
      reason: `destination branch "${branch}" matches none of the granted push patterns (${input.granted.join(", ")})`,
    }
  return { ok: true }
}

/**
 * Known residual: `git add .` and a bare `git add` with no path stage the whole
 * tree, and no wildcard can separate them from an explicit `git add ./src/x.ts`.
 * The commit gate's dirty-tree check and the review diff both surface the
 * consequence, but neither prevents it. Recorded rather than papered over.
 */
export const implicitStagingResidual = "git add . / bare git add cannot be distinguished from an explicit path by pattern"

/**
 * Known residual: a second bare refspec in a model shell (`git push origin loop/x
 * dev`) is not refused by the shell patterns, because it carries no colon, no `+`
 * and no long option. It cannot reach the default branch without becoming a colon
 * refspec, which is refused. `pushDestinationRef` closes it on the driver path.
 */
export const bareRefspecResidual =
  "a second bare refspec in a model shell is not expressible as a pattern; use pushDestinationRef on the driver path"