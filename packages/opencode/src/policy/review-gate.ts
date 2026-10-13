export * as ReviewGate from "./review-gate"

import fs from "fs"
import path from "path"
import { Effect, Result, Schema } from "effect"
import { ReviewRecord } from "./review-record"
import { PublishDrivers } from "./drivers"
import type { PublishPolicy } from "./publish-policy"

// Making the review record mean something.
//
// The record is a file in the AUTHOR's working tree, and a model can write a
// file. On its own it proves nothing: an author could write its own `LGTM` and
// name any reviewer it liked. Two things change that, and this module is the
// second of them.
//
//   1. `write` stamps the reviewer identity from the caller's own session
//      context (`ctx.sessionID`), never from a parameter the model supplies. A
//      model can therefore record a verdict, but it cannot record one *as*
//      somebody else.
//   2. `gate` refuses a verdict whose reviewer is the author. `mayMerge` already
//      knows how to compare; this supplies the author it was missing.
//
// What this does NOT do, stated here rather than left to be discovered:
//
//   - A model with shell access can write `.skein/review.json` directly, by any
//     means, naming any session id. The identity stamp above only binds the
//     sanctioned writer. Denying the path to models is task 1b.2, and it is the
//     weaker of the two controls regardless, because scoped unattended bash can
//     write the same path. Treat this as *bounded*, not trustworthy.
//   - Nothing here is OS-separated. A same-user process that can write the
//     working tree can forge the file. That residual is why the surrounding
//     controls are bounded claims — human-granted, scoped, never-listed — rather
//     than a proof of authorship.

export const WriteFailure = {
  /** The proposed record does not satisfy the reader's own closed schema. */
  malformed: "review-write-malformed",
  /** The reviewer identity is not a safe session id. */
  reviewerInvalid: "review-write-reviewer-invalid",
} as const

export type WriteFailure = (typeof WriteFailure)[keyof typeof WriteFailure]

export interface WriteInput {
  directory: string
  /**
   * The REVIEWER's session id, taken from the calling session's own context.
   * Never a model-supplied argument — that is the entire point of this function.
   */
  reviewerSessionID: string
  headSHA: string
  base: string
  independence: "independent" | "same-model"
  verdict?: "LGTM" | "NEEDS_WORK"
  findings?: ReviewRecord.Finding[]
  round: number
}

/**
 * Writes the record, having first checked it against the reader's schema.
 *
 * Validating before writing is what makes this a writer rather than a file dump:
 * a record that fails here would fail on read, and the round-trip would look like
 * a review that never happened rather than a rejected write.
 */
export function write(input: WriteInput): Effect.Effect<{ path: string }, ReviewWriteError> {
  return Effect.gen(function* () {
    const reviewerSessionID = input.reviewerSessionID
    const candidate = {
      headSHA: input.headSHA,
      base: input.base,
      reviewer: { harness: "unknown", model: "unknown", sessionID: reviewerSessionID },
      independence: input.independence,
      ...(input.verdict ? { verdict: input.verdict } : {}),
      findings: input.findings ?? [],
      round: input.round,
    }
    const validated = ReviewRecord.validate(candidate)
    if (Result.isFailure(validated))
      return yield* new ReviewWriteError({ reason: WriteFailure.malformed, detail: validated.failure })

    const target = path.join(input.directory, ...ReviewRecord.RECORD_FILE)
    yield* Effect.sync(() => fs.mkdirSync(path.dirname(target), { recursive: true }))
    // Write-then-rename so a reader never observes a half-written record: a
    // truncated JSON file reads as `review-unreadable`, which is indistinguishable
    // from corruption and loses a real verdict.
    const tmp = `${target}.${process.pid}.tmp`
    yield* Effect.sync(() => fs.writeFileSync(tmp, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o644 }))
    yield* Effect.sync(() => fs.renameSync(tmp, target))
    return { path: target }
  })
}

/**
 * The gate: may this change be merged, given the record on disk?
 *
 * Delegates the actual decision to `mayMerge` so there is one place that knows
 * what a merge requires. This only supplies the author identity the driver needs
 * and the evidence the record carries.
 */
export function gate(input: {
  directory: string
  policy: PublishPolicy.Policy
  target: string
  actor: string
  /** The session that authored the change. Without it this gate proves nothing. */
  authorSessionID?: string
  /** Require an independent review, not merely a review by someone else. */
  requireIndependent?: boolean
  /** Gates result, measured by the caller against the head. */
  gates?: { passed: boolean; sha: string }
}): Effect.Effect<PublishDrivers.Refusal, ReviewGateError> {
  return Effect.gen(function* () {
    const loaded = yield* ReviewRecord.load(input.directory)
    if (!loaded.ok)
      return yield* new ReviewGateError({ reason: loaded.reason, detail: loaded.detail })
    // `mayMerge` deliberately refuses without a merge base, because an approval
    // for an unrelated history is not an approval of anything. The record names
    // the base it reviewed, so carry it — and let the driver apply its own rule
    // rather than second-guessing it here.
    return PublishDrivers.mayMerge({
      policy: input.policy,
      target: input.target,
      actor: input.actor,
      evidence: {
        ...ReviewRecord.toMergeEvidence(loaded.record),
        // The record names the `base..head` range it reviewed, so the merge base
        // is the base the reviewer actually looked at. Carrying it is what lets
        // the driver refuse an empty merge-base instead of assuming one.
        mergeBase: loaded.record.base,
        ...(input.gates ? { gates: input.gates } : {}),
      },
      ...(input.authorSessionID ? { authorSessionID: input.authorSessionID } : {}),
      ...(input.requireIndependent ? { requireIndependent: true } : {}),
    })
  })
}

/** A record that could not be read as a review at all. */
export class ReviewGateError extends Schema.TaggedErrorClass<ReviewGateError>()("ReviewGateError", {
  reason: Schema.String,
  detail: Schema.String,
}) {}

/** A record the writer refused to produce, because it would fail on read. */
export class ReviewWriteError extends Schema.TaggedErrorClass<ReviewWriteError>()("ReviewWriteError", {
  reason: Schema.String,
  detail: Schema.String,
}) {}