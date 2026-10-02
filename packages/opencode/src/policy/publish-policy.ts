export * as PublishPolicy from "./publish-policy"

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
  // Kept byte-identical to QueueDenyRules. It looked too broad because it also
  // denied `git add` on this module's own file; the fix was to name the module
  // publish-policy.ts, not to weaken the rule. A standing deny the fork can
  // quietly narrow is not a ceiling.
  "*publish.ts*",
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

// Refused whatever the policy says, and layered after the allows — see the
// ordering note on `deriveRules`. Deliberately narrow: a pattern loose enough to
// catch a dangerous form also catches innocent commands, and a standing grant is
// where a false positive becomes permanent rather than merely annoying.
//
// `-f` is matched as a space-delimited token. Matching the two characters anywhere
// was a false positive I shipped and then caught: `*git push*-f*` refuses
// `git push origin loop/dev-fix`, and would refuse `bug-fix` and anything else whose
// branch name contains those two characters. The space delimiter is what keeps a
// legitimate branch pushable; `--force` is covered separately by `*--force*`.
//
// There is deliberately no `+refs` entry. A `+refspec` push is already refused
  // because the granted allow is anchored to `git push <remote> <branch>` and a
  // `+refs/heads/...` argument does not match it, so an entry for it would be a
  // check no test could distinguish from the anchoring. The anchoring is what is
  // tested; if that ever widens, this is the gap that reopens.
//
// KNOWN GAP: a second BARE refspec — `git push origin loop/x dev` — is still
  // allowed. It contains no colon, no `+` and no long option, so none of the
// containment patterns can see it, and argument counting is not expressible in
// this matcher (see the note above). It cannot write to `dev` without also being a
// colon refspec, so it can only overwrite the remote branch it names if that branch
// already exists and fast-forward is impossible — a lesser failure than the
// refspec hole, but a real one, and only a driver that parses the refspec can close
// it. `pushDestinationRef` in ./drivers is that check for the driver path.
const ForceRewritePatterns: readonly string[] = [
  // For git pushes this is redundant with the `-f` entry below, because `--force`
  // contains `-f`. It is kept for force semantics outside a push (`helm --force`
  // and the like), and it is NOT independently testable for pushes — so do not
  // remove the `-f` entry on the reasoning that `--force` covers it.
  "*--force*",
  "* -f *",
  "*reset*hard*",
  "*push*--delete*",
  // Refspec and option smuggling. `*` in a granted branch pattern compiles to `.*`,
  // which matches spaces and colons, so `git push origin loop/*` also matches
  // `git push origin loop/x:dev` — that pushes loop/x onto the remote's `dev`, the
  // default branch, with no flag and no refspec separator visible to a reader.
  // These three are containment patterns rather than argument counts on purpose:
  // a count expressed as trailing `*` cannot work here, because `Wildcard.match`
  // rewrites a pattern ending in ` .*` into an OPTIONAL group, so `git push * * *`
  // matches the legitimate `git push origin loop/x`.
  "git push*:*",
  "git push*--*",
  "git push*+*",
]

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
  | {
      readonly status: "granted"
      readonly policy: Policy
      /** Carried so callers can derive the closing denies; see `defaultBranchDenies`. */
      readonly defaultBranch: string
      readonly source: string
    }
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

  return { status: "granted", policy, defaultBranch: defaultBranch.success, source } satisfies Loaded
})

/** True when a command matches the never-list or a force-rewrite shape. */
export function denied(command: string): boolean {
  return [...NeverList, ...ForceRewritePatterns].some((pattern) => Wildcard.match(command, pattern))
}

// Command shapes a grant may turn from "ask" into "allow" in a model-reachable
// shell. Listed as candidates on purpose — naming what is withheld is what makes
// the exclusion checkable, rather than relying on absence going unnoticed.
const CandidateShapes: readonly string[] = [
  "git add*",
  "git commit*",
  "git checkout -b*",
  "git switch -c*",
  "git stash list",
  "git merge*",
  "gh pr merge*",
]

// Withheld whatever the policy says. Merge is not withheld for credentials — the
// operator's shells already hold an SSH key, and a granted session keeps it — but
// because a merge needs evidence (gates green, a recorded review verdict for the
// exact head SHA, CI), and evidence is produced by a driver, not by a shell
// pattern.
const DriverOnly: readonly string[] = ["*merge*"]

/**
 * Derives the allow rules a valid policy contributes.
 *
 * THREE layers, and the order is the whole mechanism. `Permission.evaluate`
 * resolves with `findLast`, so the last matching rule decides:
 *
 *   1. the never-list denies, including `*git*push*`
 *   2. these allows, which re-permit exactly the granted shapes
 *   3. the force-rewrite denies, which therefore still win
 *
 * Layer 2 must come after layer 1: a blanket `*git*push*` deny placed last would
 * make a push grant unreachable, which is the pre-existing situation this change
 * exists to fix. Layer 3 must come last of all, so `git push --force` loses even
 * though it also matches a granted push shape. That is the cost of expressing an
 * exception by ordering rather than by an exception mechanism — and it is why
 * layer 3 exists as its own list rather than being folded into the never-list.
 *
 * The allows are deliberately anchored to `git push <remote> <branch>` with no
 * room for flags, so `git -c core.hooksPath=/tmp/evil push origin loop/x` does not
 * match and falls through to the deny. Fail-closed on the shapes we did not
 * enumerate.
 *
 * Note the limit of what a pattern can express: these gate command *shapes*, not
 * the branch the session is on. "Never commit to the default branch" belongs to
 * the commit gate, because no shell pattern can see which branch is checked out.
 */
export function deriveRules(policy: Policy): PermissionV1.Ruleset {
  const local = CandidateShapes.filter(
    (shape) => !DriverOnly.some((driver) => Wildcard.match(shape, driver)) && !denied(shape),
  ).map((pattern) => ({ permission: "bash", pattern, action: "allow" as const }))

  // One allow per granted remote/branch pair rather than one broad shape, so the
  // grant is exactly what the policy says and not a superset of it.
  const pushes = policy.push.remotes.flatMap((remote) =>
    policy.push.branches.map((branch) => ({
      permission: "bash" as const,
      pattern: `git push ${remote} ${branch}`,
      action: "allow" as const,
    })),
  )

  return [...local, ...pushes]
}

/**
 * Denies derived from the repository's default branch.
 *
 * The never-list cannot carry these, because it is a code constant and the
 * default branch is a fact about the repository — `dev` here, `main` elsewhere.
 * `Wildcard.match` also has no word-boundary operator, so the shapes are matched
 * by their delimiters instead: a space before the name (the pattern is written
 * with a trailing space so `Wildcard` does not turn it into an optional group),
 * which is why `git push origin loop/device` is NOT caught while a bare `dev`
 * token is.
 *
 * `HEAD`, `@` and `.` are included because each names "whatever branch the session
 * is currently on", and the session may be on the default branch.
 */
export function defaultBranchDenies(defaultBranch: string): readonly string[] {
  return [
    `* ${defaultBranch} *`,
    `*refs/heads/${defaultBranch}*`,
    "* HEAD *",
    "* @ *",
    "* . *",
  ]
}

/** The never-list as deny rules, for a caller that needs to append them. */
export function denyRules(): PermissionV1.Ruleset {
  return NeverList.map((pattern) => ({ permission: "bash" as const, pattern, action: "deny" as const }))
}

/** The force-rewrite denies, which must be layered after any allow. */
export function forceDenyRules(): PermissionV1.Ruleset {
  return ForceRewritePatterns.map((pattern) => ({ permission: "bash" as const, pattern, action: "deny" as const }))
}

/**
 * The full ruleset for a granted policy: denies, then allows, then the closing
 * denies.
 *
 * The ordering is load-bearing and is asserted by tests that mutate each layer —
 * see the note on `deriveRules`.
 *
 * `defaultBranch` is optional so a caller that does not know it still gets a
 * working ruleset, but it SHOULD be passed: without it the closing denies cannot
 * name the repository's own default branch, and a bare second refspec can then
 * write it. `Loaded` carries it, so the value is available wherever a grant is.
 */
export function sessionRules(policy: Policy, defaultBranch?: string): PermissionV1.Ruleset {
  return [
    ...denyRules(),
    ...deriveRules(policy),
    ...forceDenyRules(),
    ...(defaultBranch ? defaultBranchDenies(defaultBranch).map(toDeny) : []),
  ]
}

const toDeny = (pattern: string): PermissionV1.Rule => ({ permission: "bash", pattern, action: "deny" })

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
export const cachedLoad = Effect.fnUntraced(function* (input: { directory: string; deps: LoadDeps; now: number }) {
  const file = path.join(input.directory, ...POLICY_FILE)
  const stamp = yield* Effect.promise(() =>
    Bun.file(file).exists().then((exists) => (exists ? Bun.file(file).lastModified : 0)),
  )
  if (stamp === 0) return undefined
  const hit = cache.get(input.directory)
  if (hit && hit.mtime === stamp && input.now - hit.checkedAt < TTLms) return hit.policy
  const loaded = yield* load({ directory: input.directory, deps: input.deps })
  const policy = loaded.status === "granted" ? loaded.policy : undefined
  cache.set(input.directory, { mtime: stamp, checkedAt: input.now, policy })
  return policy
})

/**
 * The policy for the prompt path: cached on mtime AND age.
 *
 * `now` is a parameter rather than read from the Clock service on purpose: this is
 * called from the request path, and taking Clock from the environment there would
 * widen that function's context for every caller. Passing it also makes the TTL
 * exactly controllable in tests instead of approximated by a test clock.
 *
 * A failed re-load stores the denial rather than leaving the previous grant in
 * place. That is a cost measure, not the safety mechanism: the stale entry's own
 * `checkedAt` is already past the TTL, so it would be re-loaded anyway. Safety
 * comes from refusing to serve anything unverified.
 */
export const current = Effect.fnUntraced(function* (directory: string) {
  return yield* cachedLoad({ directory, deps: systemDeps({ directory }), now: Date.now() })
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