export * as PublishPushRun from "./push-run"

import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Process } from "@/util/process"
import { PublishPolicy } from "./publish-policy"
import { pushDestinationRef } from "./drivers"

// The push executor, kept in its own module because ./drivers is under review by
// another session. Nothing here is reachable from a model shell: a driver-executed
// push never passes through `Permission.evaluate`, so the shell patterns that
// refuse `git push origin loop/x:dev` do not apply to it. The argv this module
// builds has to be safe on its own terms.
//
// Three checks, in order, each answering a question the others cannot:
//   1. is the remote NAME well formed, so it cannot be read as an option
//   2. is the branch NAME well formed, so the refspec cannot be split
//   3. is the refspec's DESTINATION inside the grant
//
// The third is the one the shell layer cannot do: `git push origin loop/x` says
// nothing about which ref on the remote is written until the refspec is parsed.

/** Git remote names: no leading dash, no path separators, no whitespace. */
const RemoteName = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/**
 * A branch name as git will accept it in a refspec.
 *
 * Deliberately not git's full `check-ref-format`: the point is to refuse anything
 * that changes the SHAPE of the command — a leading dash (read as an option), a
 * colon (splits the refspec), whitespace, or a path traversal.
 */
const BranchName = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export type Rejection = { readonly ok: false; readonly reason: string }

/**
 * Builds the argv for an allowed push, or says why not.
 *
 * Uses `--` to end option parsing, so even a value that slipped past the name
 * checks is read as a positional argument rather than a flag.
 */
export function buildArgv(input: {
  policy: PublishPolicy.Policy
  remote: string
  branch: string
}): { ok: true; argv: string[] } | Rejection {
  if (!RemoteName.test(input.remote))
    return {
      ok: false,
      reason: `remote "${input.remote}" is not a well-formed remote name; refusing to put it in an argument slot`,
    }
  if (!BranchName.test(input.branch))
    return {
      ok: false,
      reason: `branch "${input.branch}" is not a well-formed branch name; a leading dash, colon or whitespace would change the command`,
    }
  if (!input.policy.push.remotes.includes(input.remote))
    return { ok: false, reason: `remote "${input.remote}" is not granted` }
  if (!input.policy.push.branches.some((pattern) => Wildcard.match(input.branch, pattern)))
    return { ok: false, reason: `branch "${input.branch}" is not granted` }

  const refspec = `HEAD:refs/heads/${input.branch}`
  // For the argv built above this is the same question as the branch grant check
  // above, so neither is individually observable by mutating it alone — they mask
  // each other. It is kept because it asks the question that actually matters ("is
  // the ref this writes inside the grant?") and because it becomes load-bearing the
  // moment the refspec stops being derived from `branch` alone — for instance if
  // `src:dest` syntax is ever accepted.
  const destination = pushDestinationRef({ refspec, granted: input.policy.push.branches })
  if (!destination.ok) return { ok: false, reason: destination.reason }

  return { ok: true, argv: ["push", "--", input.remote, refspec] }
}

export interface PushOutcome {
  readonly code: number
  readonly output: string
  readonly argv: readonly string[]
  readonly remote: string
  readonly branch: string
}

/**
 * Runs a push, or refuses before running anything.
 *
 * Returns the refusal as a value rather than throwing, because a driver that
 * cannot push must say which check stopped it.
 */
export async function run(input: {
  cwd: string
  policy: PublishPolicy.Policy
  remote: string
  branch: string
}): Promise<PushOutcome | Rejection> {
  const argv = buildArgv(input)
  if (!argv.ok) return argv

  // `Process.text` is already promise-based, so wrapping it in Effect here would add
  // a context requirement to every caller without changing what runs.
  const result = await Process.text(["git", ...argv.argv], { cwd: input.cwd, nothrow: true })
  return {
    code: result.code,
    output: result.text,
    argv: argv.argv,
    remote: input.remote,
    branch: input.branch,
  }
}