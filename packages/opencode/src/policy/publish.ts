export * as PublishPolicy from "./publish"

import path from "path"
import { Clock, Effect, Result, Schema } from "effect"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Process } from "@/util/process"

// D1: a standing, per-repo authorization that satisfies the way-of-working rule
// ("publishing needs explicit instruction for that action") once, durably,
// instead of per-push.
//
// The constraint that shapes everything here is that loading fails CLOSED. A
// policy that still parses but has quietly stopped meaning anything is worse
// than no policy, because it reads as authorization. So every rejection returns
// "no grant" with one reason rather than a partially-applied policy, and the
// session continues under today's rules.

// A code constant, deliberately NOT in the schema: a never-list a policy file
// could relax would be a knob the model can edit, which is the thing the grant
// exists to prevent. Because the schema is closed, a `neverList:` key in a
// policy file is rejected as unknown rather than silently honoured.
//
// The command shapes are the existing `QueueDenyRules` patterns. They are
// restated because this module must not depend on the loop package; task 2.2 is
// what proves the two sets agree rather than trusting this comment.
export const NeverList: readonly string[] = [
  "*git*push*",
  "*git*tag*",
  "*git*remote*",
  "*gh*release*",
  "*gh*pr*merge*",
  "*gh*workflow*run*",
  "*gh*api*",
  "*npm*publish*",
  "*bun*publish*",
  "*pnpm*publish*",
  "*yarn*publish*",
  "*cargo*publish*",
  "*deploy*",
  "*fleet-deploy*",
  // Narrowed from QueueDenyRules' `*publish.ts*`, which also denied `git add` on
  // any file with that name — a false positive in a standing grant is permanent.
  // This matches invoking the script, not naming it. Task 2.2 decides whether
  // QueueDenyRules gets the same narrowing.
  "*run*publish.ts*",
  "*publish.ts*run*",
  "*script/release*",
  "*ssh*",
  "*scp*",
  "*rsync*",
  "*pct*",
  "*systemctl*",
  "*launchctl*",
  "*credential*",
  "*git*config*",
]

// Refused whatever the policy says. Deliberately narrow: a pattern loose enough
// to catch a dangerous form also catches innocent commands, and a standing grant
// is where a false positive becomes permanent rather than annoying.
const ForceRewritePatterns: readonly string[] = ["*--force*", "*reset*hard*", "*push*--delete*"]

const Branches = Schema.Array(Schema.String)

const Policy = Schema.Struct({
  version: Schema.Literal(1),
  repo: Schema.String,
  visibility: Schema.Literals(["public", "private"]),
  commit: Schema.Struct({ branches: Branches }),
  push: Schema.Struct({ remotes: Schema.Array(Schema.String), branches: Branches }),
  merge: Schema.Struct({
    into: Schema.Array(Schema.String),
    method: Schema.Literals(["squash", "merge", "rebase"]),
    // Evidence the merge driver must see. `review` means a recorded verdict for
    // the head SHA, not a human's assurance in chat.
    requires: Schema.Array(Schema.Literals(["gates", "review", "ci"])),
    by: Schema.Array(Schema.String),
  }),
  scan: Schema.optional(Schema.Literals(["public-content"])),
})

export type Policy = typeof Policy.Type

export interface LoadDeps {
  /** Asked of the forge, never inferred from the remote URL: a private and a
   * public repo look identical from the client. A failure here means "cannot
   * confirm", which denies rather than assuming a match. */
  readonly visibility: (repo: string) => Effect.Effect<string, unknown>
  readonly remoteUrl: (remote: string) => Effect.Effect<string | undefined, unknown>
  readonly defaultBranch: Effect.Effect<string, unknown>
  readonly readFile: (file: string) => Effect.Effect<string | undefined, unknown>
}

export type Loaded =
  | { readonly status: "granted"; readonly policy: Policy; readonly source: string }
  | {
      readonly status: "denied"
      readonly reason: Reason
      readonly detail: string
      readonly source: string
    }

export const POLICY_FILE = [".skein", "publish-policy.yaml"]

/**
 * Every way loading can refuse, as a distinct named value.
 *
 * Named rather than inlined because Phase 2 logs this in the session's line, and
 * a log that can only be read by pattern-matching prose is a log nobody can
 * alert on. The set is closed: a reason not in here is a bug, and `Reason` is the
 * union callers match on.
 */
export const Reason = {
  /** No policy file at the expected path. */
  absent: "policy-absent",
  /** The file did not satisfy the closed schema (unknown key, wrong type, bad literal). */
  malformed: "policy-malformed",
  /** The repo's default branch could not be determined, so no ceiling could be checked. */
  defaultBranchUnknown: "default-branch-unknown",
  /** A granted branch pattern also covers the default branch. */
  grantsDefaultBranch: "grants-default-branch",
  /** A named remote does not point at the repo the policy asserts. */
  remoteRepoMismatch: "remote-repo-mismatch",
  /** The remote configuration could not be read. */
  remoteUnreadable: "remote-unreadable",
  /** The forge could not be asked, so visibility is unconfirmed. */
  forgeUnreachable: "forge-unreachable",
  /** The forge answered, and disagreed with the policy's asserted visibility. */
  visibilityMismatch: "visibility-mismatch",
  /** The public-content scan was claimed for a repo the policy calls private. */
  scanNeedsPublic: "scan-needs-public",
} as const

export type Reason = (typeof Reason)[keyof typeof Reason]

/**
 * The real dependencies: `git` for remotes and the default branch, `gh` for
 * visibility.
 *
 * Kept separate from `load` so the validation logic stays a pure function of its
 * inputs and every rejection above can be exercised without a repository or a
 * network. This factory is what production wires in, and it is the only place
 * that shells out.
 */
export const systemDeps = (input: { directory: string }): LoadDeps => ({
  // Asked of the forge rather than inferred from the remote URL: a private and a
  // public repo look identical from the client. A non-zero exit becomes a
  // failure, which `load` treats as "cannot grant" rather than "assume fine".
  //
  // The reported value is lower-cased at this boundary: `gh` answers "PUBLIC",
  // while a policy file reads `visibility: public`. Comparing them raw made every
  // real policy report a visibility mismatch, so the grant could never apply.
  visibility: (repo) =>
    Effect.promise(() => Process.text(["gh", "repo", "view", repo, "--json", "visibility"], { nothrow: true })).pipe(
      Effect.flatMap((out) => {
        const reported = (() => {
          try {
            return (JSON.parse(out.text) as { visibility?: string }).visibility?.toLowerCase()
          } catch {
            return undefined
          }
        })()
        return reported ? Effect.succeed(reported) : Effect.fail(new Error(`gh could not report visibility for ${repo}`))
      }),
    ),

  remoteUrl: (remote) =>
    Effect.promise(() => Process.text(["git", "remote", "get-url", remote], { cwd: input.directory, nothrow: true })).pipe(
      Effect.map((out) => (out.code === 0 ? out.text.trim() : undefined)),
    ),

  // Read from the repository rather than assumed, in two steps: origin/HEAD
  // first, then whatever remote-tracking branch the current branch is built on.
  // The second step matters in a fresh clone where `git remote set-head` was never
  // run but a feature branch already tracks its base.
  //
  // If neither answers, `load` denies. Guessing is exactly what a standing grant
  // must not rest on: the default branch is the one ref a grant must never cover.
  defaultBranch: Effect.promise(() =>
    Process.text(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: input.directory,
      nothrow: true,
    }),
  ).pipe(
    Effect.flatMap((out) => {
      const head = out.code === 0 ? out.text.trim().replace(/^origin\//, "") : ""
      if (head) return Effect.succeed(head)
      return Effect.promise(() =>
        Process.text(["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
          cwd: input.directory,
          nothrow: true,
        }),
      ).pipe(
        Effect.flatMap((up) => {
          // `origin/feature/x` is not the default branch, so only an upstream
          // whose remote part is unambiguous is used; anything else denies.
          const ref = up.code === 0 ? up.text.trim() : ""
          const base = ref.match(/^[^/]+\/([^/]+)$/)?.[1]
          return base ? Effect.succeed(base) : Effect.fail(new Error("no default branch could be determined"))
        }),
      )
    }),
  ),

  readFile: (file) =>
    Effect.promise(() => Bun.file(file).exists()).pipe(
      Effect.flatMap((exists) => (exists ? Effect.promise(() => Bun.file(file).text()) : Effect.succeed(undefined))),
    ),
})

/**
 * Loads the publish policy for a repository, granting nothing unless every
 * check passes.
 *
 * A denial is an ordinary return value rather than an error, because D2 has the
 * session continue under today's rules with one logged reason. An absent file
 * and an invalid file are deliberately indistinguishable to callers — both are
 * "no grant" — so no caller can come to depend on the difference.
 */
export const load = Effect.fn("PublishPolicy.load")(function* (input: { directory: string; deps: LoadDeps }) {
  const source = path.join(input.directory, ...POLICY_FILE)
  // `reason` is the stable token a caller matches and alerts on; `detail` is the
  // specifics, which differ per repository and so cannot be part of the token.
  const deny = (reason: Reason, detail: string): Loaded => ({ status: "denied", reason, detail, source })

  const text = yield* input.deps.readFile(source)
  if (text === undefined) return deny(Reason.absent, `no policy at ${source}`)

  const decoded = yield* decode(text).pipe(Effect.result)
  if (Result.isFailure(decoded)) return deny(Reason.malformed, decoded.failure.message)
  const policy = decoded.success

  // A pattern matching the default branch would let a granted session commit or
  // push straight to it, so it is refused at load rather than at push time.
  // `Wildcard.match` is the same matcher `Permission.evaluate` uses, so this
  // check and the eventual gate cannot disagree about what a pattern covers.
  const defaultBranch = yield* input.deps.defaultBranch.pipe(Effect.result)
  if (Result.isFailure(defaultBranch))
    return deny(Reason.defaultBranchUnknown, "no default branch could be read, so no ceiling could be checked")
  const unsafe = [...policy.commit.branches, ...policy.push.branches].filter((pattern) =>
    Wildcard.match(defaultBranch.success, pattern),
  )
  if (unsafe.length)
    return deny(
      Reason.grantsDefaultBranch,
      `pattern(s) ${unsafe.join(", ")} cover the default branch "${defaultBranch.success}"`,
    )

  const remotes = yield* Effect.forEach(policy.push.remotes, (remote) =>
    input.deps.remoteUrl(remote).pipe(Effect.map((url) => (repoOf(url) === policy.repo ? undefined : remote))),
  ).pipe(Effect.result)
  if (Result.isFailure(remotes)) return deny(Reason.remoteUnreadable, "the remote configuration could not be read")
  const mismatched = remotes.success.filter((remote): remote is string => remote !== undefined)
  if (mismatched.length)
    return deny(Reason.remoteRepoMismatch, `remote(s) ${mismatched.join(", ")} do not point at ${policy.repo}`)

  // An unreachable forge is a denial, not a skip. Assuming it matches would make
  // the check pass precisely when it could not be run.
  const visibility = yield* input.deps.visibility(policy.repo).pipe(Effect.result)
  if (Result.isFailure(visibility))
    return deny(Reason.forgeUnreachable, `the forge could not be asked about ${policy.repo}`)
  if (visibility.success !== policy.visibility)
    return deny(
      Reason.visibilityMismatch,
      `the policy asserts ${policy.visibility}, the forge reports ${visibility.success}`,
    )

  if (policy.scan === "public-content" && policy.visibility !== "public")
    return deny(Reason.scanNeedsPublic, "the scan is claimed for a repo the policy calls private")

  return { status: "granted", policy, source } satisfies Loaded
})

/** True when a command matches the never-list or a force-rewrite shape. */
export function denied(command: string): boolean {
  return [...NeverList, ...ForceRewritePatterns].some((pattern) => Wildcard.match(command, pattern))
}

// Command shapes a grant may turn from "ask" into "allow" in a model-reachable
// shell. Deliberately not a list of what the grant permits, but a list of what it
// might plausibly permit; the two filters below decide.
const CandidateShapes: readonly string[] = [
  "git add*",
  "git commit*",
  "git checkout -b*",
  "git switch -c*",
  "git stash list",
  "git push*",
  "gh pr merge*",
  "git tag*",
]

// Shapes that stay out of a model shell no matter what the policy says: D4 keeps
// push and merge driver-executed so no model-reachable shell ever holds
// credentials. Listed here as candidates on purpose — naming what is withheld is
// what makes the exclusion checkable, rather than relying on their absence from
// the list above going unnoticed.
const DriverOnly: readonly string[] = ["*push*", "*merge*", "*tag*"]

/**
 * Derives the allow rules a valid policy contributes.
 *
 * Three invariants, two of them enforced rather than left to a comment:
 *
 * 1. **A deny always wins.** `Permission.evaluate` resolves with `findLast`, so
 *    the LAST matching rule decides. These allows are therefore meant to be
 *    layered BEFORE the never-list denies; a caller that appends them after would
 *    invert the whole ceiling. `sessionRules` returns them already ordered.
 * 2. **Driver-executed shapes are never emitted.** Filtered by name, not by
 *    hoping the never-list happens to refuse them.
 * 3. **No allow covers something the never-list denies**, so the ceiling does not
 *    depend on every call site ordering the rulesets correctly.
 *
 * Filters 2 and 3 overlap on today's lists — every `DriverOnly` shape is already
 * denied by `*git*push*` and friends — so filter 3 is defence in depth that
 * currently removes nothing. Only filter 2 is carrying weight today, and the
 * tests say so rather than implying both are load-bearing.
 *
 * Note the limit of what a pattern can express: these allows gate command
 * *shapes*, not the branch the session is on. "Never commit to the default
 * branch" belongs to the commit gate, because no shell pattern can see which
 * branch is checked out.
 */
export function deriveRules(_policy: Policy): PermissionV1.Ruleset {
  return CandidateShapes.filter(
    (shape) => !DriverOnly.some((driver) => Wildcard.match(shape, driver)) && !denied(shape),
  ).map((pattern) => ({
    permission: "bash",
    pattern,
    action: "allow",
  }))
}

/** The never-list as deny rules, for a caller that needs to append them. */
export function denyRules(): PermissionV1.Ruleset {
  return [...NeverList, ...ForceRewritePatterns].map((pattern) => ({
    permission: "bash",
    pattern,
    action: "deny",
  }))
}

/**
 * The full ruleset for a granted policy: allows first, never-list denies last,
 * so `findLast` lands on a deny whenever both match.
 */
export function sessionRules(policy: Policy): PermissionV1.Ruleset {
  return [...deriveRules(policy), ...denyRules()]
}

/**
 * The standing-authorization section injected into a session's prompt.
 *
 * This is a rendering, not the enforcement: it tells the model what its user
 * authorized so it stops asking, while the rules above are what actually decide.
 * Kept separate so the two can disagree visibly in review rather than silently.
 *
 * It deliberately does NOT claim the branch ceiling is enforced here. The derived
 * allows gate command shapes, and no shell pattern can see which branch is
 * checked out, so promising branch safety in the prompt would be a lie the model
 * could act on.
 */
export function promptSection(policy: Policy): string {
  return [
    `Standing authorization from your user for ${policy.repo}:`,
    `- commit on branches matching ${policy.commit.branches.join(", ")}`,
    `- push ${policy.push.remotes.map((r) => `${r}/${policy.push.branches.join(",")}`).join(", ")} — driver-executed; ask for it, do not run it yourself`,
    `- merge into ${policy.merge.into.join(", ")} by ${policy.merge.by.join(", ")}, ${policy.merge.method}, requiring ${policy.merge.requires.join(", ")}`,
    policy.scan === "public-content"
      ? "- the outgoing diff is scanned for private content before any push; a hit blocks it and is reported"
      : undefined,
    "",
    "This is the explicit instruction your general guidance asks for, and it is durable. It never covers history rewrites, tag or release publication, remote mutation, credential or git-config changes, deploy or remote-execution surfaces — those stay refused whatever this file says.",
    "",
    "The commit permission above is not a promise that the current branch is one of the listed ones: that check is made when the commit is made, not by your shell. Check the branch yourself before committing.",
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

// The one sentence in kimi.txt that makes a durable grant impossible: it asks for
// confirmation on every git mutation "even if the user has confirmed in earlier
// conversations", which no standing authorization can ever satisfy. Removed only
// when a policy actually grants, and matched exactly so a future edit to kimi.txt
// cannot silently stop the removal.
const KimiAskEachTime =
  "Ask for confirmation each time when you need to do git mutations, even if the user has confirmed in earlier conversations."

/**
 * Applies a granted policy to a session's system prompt.
 *
 * With no policy the caller must not call this at all — the point of the
 * conditional is that an ungranted session's prompt is byte-for-byte what it was
 * before this module existed, so the absence of a policy leaves no trace.
 */
export function applyToPrompt(prompts: string[], policy: Policy): string[] {
  return [...prompts.map(stripAskEachTime), promptSection(policy)]
}

function stripAskEachTime(prompt: string): string {
  if (!prompt.includes(KimiAskEachTime)) return prompt
  // Collapse the double space the sentence leaves behind, so the surrounding text
  // does not change shape when the clause is lifted out.
  return prompt.replace(` ${KimiAskEachTime}`, "").replace(KimiAskEachTime, "")
}

/**
 * The policy in force for a directory, or undefined.
 *
 * Cached on the policy file's mtime. The lookup shells out to `gh` and `git`, so
 * running it on every model request would put a subprocess on the hot path; keying
 * on mtime rather than on the directory means an edited policy takes effect on the
 * next request instead of after a restart. `InstanceState` would give per-directory
 * caching too, but it requires a scoped layer, and a grant lookup is not worth
 * making this module a service.
 */
/**
 * Composes a session's system prompt, applying the grant only when one exists.
 *
 * The `granted === undefined` branch is the important one and must stay
 * byte-for-byte identical to pre-policy behaviour: no section, no clause removal,
 * no added whitespace. A session without a grant should not be able to tell that
 * this module exists.
 */
export function composeSystem(
  basePrompts: string[],
  granted: Policy | undefined,
  ...rest: ReadonlyArray<string | undefined>
): string {
  // `.flat()` before the filter matters: the pre-policy expression was
  // `[...base, ...rest].filter(Boolean)`, which dropped an empty base prompt along
  // with an undefined rest entry. Filtering only the outer array would keep the
  // empty string and add a leading newline to every ungranted session.
  return [(granted ? applyToPrompt(basePrompts, granted) : basePrompts), ...rest].flat().filter((x) => x).join("\n")
}

/**
 * How long a resolved policy may be reused before the full load runs again.
 *
 * The mtime alone is not a sufficient cache key, and getting that wrong is the
 * exact failure this module exists to prevent. The loader's verdict depends on
 * facts OUTSIDE the policy file — the forge's visibility, the remote's URL, and
 * origin/HEAD. A repository flipped from private to public, or a remote
 * repointed, leaves the file untouched, so an mtime-keyed cache keeps serving a
 * grant the loader would now refuse. The TTL bounds how long that can persist.
 */
const TTLms = 60_000

const cache = new Map<string, { mtime: number; checkedAt: number; policy: Policy | undefined }>()

/**
 * The cached load.
 *
 * Separate from `current` only so the cache can be driven with injected
 * dependencies; there is one implementation, not a test-only twin.
 */
export const cachedLoad = Effect.fnUntraced(function* (input: { directory: string; deps: LoadDeps }) {
  const file = path.join(input.directory, ...POLICY_FILE)
  const stamp = yield* Effect.promise(() =>
    Bun.file(file).exists().then((exists) => (exists ? Bun.file(file).lastModified : 0)),
  )
  if (stamp === 0) return undefined
  const now = yield* Clock.currentTimeMillis
  const hit = cache.get(input.directory)
  if (hit && hit.mtime === stamp && now - hit.checkedAt < TTLms) return hit.policy
  const loaded = yield* load({ directory: input.directory, deps: input.deps })
  const policy = loaded.status === "granted" ? loaded.policy : undefined
  cache.set(input.directory, { mtime: stamp, checkedAt: now, policy })
  return policy
})

/**
 * The policy for the prompt path: cached on mtime AND age.
 *
 * A failed re-load stores the denial rather than leaving the previous grant in
 * place. That is a cost measure, not the safety mechanism: the stale entry's own
 * `checkedAt` is already past the TTL, so it would be re-loaded anyway. Storing
 * the denial just avoids re-shelling-out on every request while the forge is
 * down. The safety comes from the age check refusing to serve anything unverified
 * — not from this write, which a mutation removing it does not catch.
 */
export const current = Effect.fnUntraced(function* (directory: string) {
  return yield* cachedLoad({ directory, deps: systemDeps({ directory }) })
})

/**
 * The full load, with no cache at all.
 *
 * This is what an action-time caller uses. The prompt path can afford a cached
 * answer; a driver about to push or merge cannot, because the decision it makes
 * with the policy is the one that publishes something.
 */
export const loadNow = Effect.fnUntraced(function* (directory: string) {
  const loaded = yield* load({ directory, deps: systemDeps({ directory }) })
  return loaded.status === "granted" ? loaded.policy : undefined
})

/** Drops the cached entry for a directory. Exists for tests and for an explicit reload. */
export function invalidate(directory: string) {
  cache.delete(directory)
}

const decode = (text: string) =>
  // `onExcessProperty: "error"` is what makes the schema closed: an unknown key
  // is a rejection, so a typo — or an attempt to add a permissive knob — fails
  // here instead of being ignored.
  Schema.decodeUnknownEffect(Policy, {
    errors: "all",
    onExcessProperty: "error",
    propertyOrder: "original",
  })(Bun.YAML.parse(text) as never)

/** Extracts `owner/name` from the git remote forms that actually occur. */
function repoOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  // scp-style (`git@host:owner/name`) is what `git clone` writes by default and
  // is separated by a colon, not a slash, so it does not share a prefix with the
  // URL forms.
  const scp = url.trim().match(/^(?:git@|ssh:\/\/git@)[^:/]+:([^/]+\/[^/]+)$/)?.[1]
  if (scp) return scp.replace(/\.git$/, "")
  return url
    .trim()
    .match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
}