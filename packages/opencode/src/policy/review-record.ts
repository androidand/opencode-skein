export * as ReviewRecord from "./review-record"

import fs from "fs"
import path from "path"
import { Effect, Result, Schema } from "effect"
import { PublishPolicy } from "./publish-policy"
import { PublishDrivers } from "./drivers"

// The review record: what a reviewer said about one exact commit.
//
// It exists because the merge driver refuses every merge until a verdict exists
// for the head being merged, and because the verdict has to be attributable to
// something that was actually written down. A model's claim that it reviewed
// something is not a record of a review; this is.
//
// The head SHA is the load-bearing field. A verdict for an earlier commit does not
// cover the head, so every field that carries an opinion carries the commit it is
// about, and a record whose head does not match what is being merged is refused by
// the consumer rather than silently accepted here.
//
// Gates and CI evidence deliberately do NOT live in this file. They are produced
// by the driver, measured against a SHA, and mixing a reviewer's opinion with a
// machine's measurement in one record would make it impossible to tell which
// claim failed when a merge is refused.

export const RECORD_FILE = [".skein", "review.json"]

/** A full object id. Abbreviations are refused: two commits can share a prefix. */
const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * Every way reading a record can refuse, as a distinct named value.
 *
 * Named for the same reason `PublishPolicy.Reason` is: Phase 4 will log this in
 * the session's line, and a log that can only be read by pattern-matching prose is
 * a log nobody can alert on.
 */
export const Reason = {
  /** No record at the expected path. */
  absent: "review-absent",
  /** The file was not readable as JSON. */
  unreadable: "review-unreadable",
  /** The file did not satisfy the closed schema. */
  malformed: "review-malformed",
  /** `headSHA` is not a full 40-character object id. */
  headNotFullSha: "review-head-not-full-sha",
  /** `verdict` is set but `reviewedSHA` is missing or does not equal `headSHA`. */
  verdictNotForHead: "review-verdict-not-for-head",
  /** The record's round is below 1. */
  roundInvalid: "review-round-invalid",
} as const

export type Reason = (typeof Reason)[keyof typeof Reason]

const Severity = Schema.Literals(["blocking", "advisory"])

const Finding = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  severity: Severity,
  text: Schema.String,
})

const Record_ = Schema.Struct({
  headSHA: Schema.String,
  base: Schema.String,
  reviewer: Schema.Struct({ harness: Schema.String, model: Schema.String }),
  independence: Schema.Literals(["independent", "same-model"]),
  /** Optional: a round that ended without a verdict is a valid record, and is not a pass. */
  verdict: Schema.optional(Schema.Literals(["LGTM", "NEEDS_WORK"])),
  /** Required whenever `verdict` is set; must equal `headSHA`. Enforced in `validate`. */
  reviewedSHA: Schema.optional(Schema.String),
  findings: Schema.Array(Finding),
  round: Schema.Number,
})

export type Record = typeof Record_.Type
export type Finding = typeof Finding.Type

/**
 * Validates an already-parsed record.
 *
 * Separate from the schema because the interesting rules are cross-field — a
 * verdict whose SHA is not the head — and a closed schema cannot express those.
 * Every failure names a reason rather than returning a bare false, because the
 * consumer has to be able to tell "no review yet" from "a review that does not
 * count".
 */
export function validate(input: unknown): Result.Result<Record, Reason> {
  const decoded = Effect.runSync(
    Effect.result(
      Schema.decodeUnknownEffect(Record_, {
        errors: "all",
        // Closed: a typo, or a field added later and silently ignored, is the failure
        // mode this whole module exists to prevent.
        onExcessProperty: "error",
        propertyOrder: "original",
      })(input),
    ),
  )
  if (Result.isFailure(decoded)) return Result.fail(Reason.malformed)
  const record = decoded.success

  if (!FULL_SHA.test(record.headSHA)) return Result.fail(Reason.headNotFullSha)
  if (!Number.isInteger(record.round) || record.round < 1) return Result.fail(Reason.roundInvalid)
  // A verdict without the SHA it covers is the single most dangerous shape this
  // record can take: it reads as an approval and covers nothing.
  if (record.verdict !== undefined && (record.reviewedSHA === undefined || record.reviewedSHA !== record.headSHA))
    return Result.fail(Reason.verdictNotForHead)
  return Result.succeed(record)
}

export type Loaded =
  | { readonly ok: true; readonly record: Record; readonly source: string }
  | { readonly ok: false; readonly reason: Reason; readonly detail: string; readonly source: string }

/**
 * Reads `.skein/review.json` for a directory.
 *
 * An absent record and an invalid one are deliberately distinguishable here, at
 * the boundary, because "no review yet" and "a review that does not count" are
 * different facts for whoever is waiting on a merge. Downstream, both become "no
 * verdict" — but the reason token says which.
 */
export function load(directory: string): Effect.Effect<Loaded> {
  const source = path.join(directory, ...RECORD_FILE)
  const refuse = (reason: Reason, detail: string): Loaded => ({ ok: false, reason, detail, source })
  if (!fs.existsSync(source)) return Effect.succeed(refuse(Reason.absent, `no review record at ${source}`))

  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(source, "utf8"))
  } catch (err) {
    return Effect.succeed(refuse(Reason.unreadable, `could not parse ${source}: ${String(err)}`))
  }
  const validated = validate(raw)
  if (Result.isFailure(validated)) return Effect.succeed(refuse(validated.failure, `${source}: ${validated.failure}`))
  return Effect.succeed({ ok: true, record: validated.success, source })
}

/**
 * Maps a record onto the merge driver's evidence shape.
 *
 * Two rules, both deliberate:
 *   - the verdict's SHA is the record's `headSHA`, never `reviewedSHA`, because
 *     `validate` has already established they are equal and the driver should not
 *     have to know that
 *   - a record with no verdict yields no `reviewVerdict` at all, rather than a
 *     passing one. "The reviewer replied without a token" is not an approval.
 *
 * Gates, CI and mergeBase are left absent: they are the driver's to measure.
 */
export function toMergeEvidence(record: Record): PublishDrivers.MergeEvidence {
  return {
    headSHA: record.headSHA,
    reviewVerdict:
      record.verdict === undefined ? undefined : { verdict: record.verdict, sha: record.headSHA },
  }
}

/** Convenience: read a directory and map it, answering "is there a verdict for this head". */
export function evidenceFor(directory: string): Effect.Effect<{
  evidence: PublishDrivers.MergeEvidence
  reason?: Reason
}> {
  return Effect.gen(function* () {
    const loaded = yield* load(directory)
    if (!loaded.ok) return { evidence: { headSHA: "" }, reason: loaded.reason }
    return { evidence: toMergeEvidence(loaded.record) }
  })
}

/** Kept so the policy's reason vocabulary stays the single place a caller looks. */
export type PolicyReason = PublishPolicy.Reason
