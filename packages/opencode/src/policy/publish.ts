export * as PublishPolicy from "./publish"

import path from "path"
import { Effect, Result, Schema } from "effect"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
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
  | { readonly status: "denied"; readonly reason: string; readonly source: string }

export const POLICY_FILE = [".skein", "publish-policy.yaml"]

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
  visibility: (repo) =>
    Effect.promise(() => Process.text(["gh", "repo", "view", repo, "--json", "visibility"], { nothrow: true })).pipe(
      Effect.flatMap((out) => {
        const reported = (() => {
          try {
            return (JSON.parse(out.text) as { visibility?: string }).visibility
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

  // Read from origin/HEAD rather than assumed. A repository whose remote HEAD was
  // never fetched has no answer, and `load` denies rather than falling back to a
  // hardcoded name — the guess is exactly what a standing grant must not rest on.
  defaultBranch: Effect.promise(() =>
    Process.text(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: input.directory,
      nothrow: true,
    }),
  ).pipe(
    Effect.flatMap((out) => {
      const ref = out.code === 0 ? out.text.trim().replace(/^origin\//, "") : ""
      return ref ? Effect.succeed(ref) : Effect.fail(new Error("origin/HEAD is not set"))
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
  const deny = (reason: string): Loaded => ({ status: "denied", reason, source })

  const text = yield* input.deps.readFile(source)
  if (text === undefined) return deny("no publish policy")

  const decoded = yield* decode(text).pipe(Effect.result)
  if (Result.isFailure(decoded)) return deny(decoded.failure.message)
  const policy = decoded.success

  // A pattern matching the default branch would let a granted session commit or
  // push straight to it, so it is refused at load rather than at push time.
  // `Wildcard.match` is the same matcher `Permission.evaluate` uses, so this
  // check and the eventual gate cannot disagree about what a pattern covers.
  const defaultBranch = yield* input.deps.defaultBranch.pipe(Effect.result)
  if (Result.isFailure(defaultBranch))
    return deny("could not determine the default branch, so no ceiling can be checked")
  const unsafe = [...policy.commit.branches, ...policy.push.branches].filter((pattern) =>
    Wildcard.match(defaultBranch.success, pattern),
  )
  if (unsafe.length)
    return deny(`branch pattern(s) ${unsafe.join(", ")} match the default branch "${defaultBranch.success}"`)

  const remotes = yield* Effect.forEach(policy.push.remotes, (remote) =>
    input.deps.remoteUrl(remote).pipe(Effect.map((url) => (repoOf(url) === policy.repo ? undefined : remote))),
  ).pipe(Effect.result)
  if (Result.isFailure(remotes)) return deny("could not read the remote configuration")
  const mismatched = remotes.success.filter((remote): remote is string => remote !== undefined)
  if (mismatched.length) return deny(`remote(s) ${mismatched.join(", ")} do not point at ${policy.repo}`)

  // An unreachable forge is a denial, not a skip. Assuming it matches would make
  // the check pass precisely when it could not be run.
  const visibility = yield* input.deps.visibility(policy.repo).pipe(Effect.result)
  if (Result.isFailure(visibility))
    return deny(`visibility could not be confirmed: the forge was unreachable or refused ${policy.repo}`)
  if (visibility.success !== policy.visibility)
    return deny(`visibility mismatch: the policy asserts ${policy.visibility}, the forge reports ${visibility.success}`)

  if (policy.scan === "public-content" && policy.visibility !== "public")
    return deny("the public-content scan requires visibility: public")

  return { status: "granted", policy, source } satisfies Loaded
})

/** True when a command matches the never-list or a force-rewrite shape. */
export function denied(command: string): boolean {
  return [...NeverList, ...ForceRewritePatterns].some((pattern) => Wildcard.match(command, pattern))
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