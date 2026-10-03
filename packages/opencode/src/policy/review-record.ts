export * as ReviewRecord from "./review-record"

import fs from "fs"
import path from "path"
import { Effect, Result, Schema } from "effect"
import { PublishDrivers } from "./drivers"

// The review record: what a reviewer said about one exact commit.
//
// It exists because the merge driver refuses every merge until a verdict exists
// for the head being merged, and because that verdict has to be attributable to
// something written down. A model's claim that it reviewed something is not a
// record of a review; this is.
//
// The head SHA is the load-bearing field, and it is the ONLY sha a verdict
// carries. A review is made for one head, so a verdict in a record whose headSHA
// is H is about H — a second field naming the same commit would be an invariant
// that can only ever agree with the first, and the driver already refuses any
// record whose headSHA is not the head it is merging.
//
// Gates and CI evidence deliberately do NOT live in this file. They are produced
// by the driver and measured against a SHA; mixing a reviewer's opinion with a
// machine's measurement in one record would make it impossible to tell which
// claim failed when a merge is refused.

export const RECORD_FILE = [".skein", "review.json"]

/** A full object id. Abbreviations are refused: two commits can share a prefix. */
const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * Session ids are constrained to the same charset as lead grant ids: this value
 * ends up in a comparison against an authenticated identity, so it must not be a
 * place to smuggle structure.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Every way reading a record can refuse, as a distinct named value.
 *
 * Named for the same reason `PublishPolicy.Reason` is: a later phase logs this in
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
  /** `base` is not a full 40-character object id. */
  baseNotFullSha: "review-base-not-full-sha",
  /** `reviewer.sessionID` is missing or outside the safe id charset. */
  reviewerSessionInvalid: "review-reviewer-session-invalid",
  /** A finding's `line` is present but is not a line number (zero or negative). */
  findingLineInvalid: "review-finding-line-invalid",
  /** A blocking finding names no `line`, so it cannot be acted on. */
  findingLineMissing: "review-finding-line-missing",
  /** The record's round is below 1. */
  roundInvalid: "review-round-invalid",
} as const

export type Reason = (typeof Reason)[keyof typeof Reason]

const Severity = Schema.Literals(["blocking", "advisory"])

const Finding = Schema.Struct({
  file: Schema.String,
  /**
   * `Schema.Int` rather than `Schema.Number`: the latter accepts 1.5, NaN and
   * Infinity. Whether a number is a line at all (>0) is a per-finding rule and
   * lives in `validate`, alongside the rule that a blocking finding must have one.
   */
  line: Schema.optional(Schema.Int),
  severity: Severity,
  text: Schema.String,
})

const Record_ = Schema.Struct({
  headSHA: Schema.String,
  base: Schema.String,
  reviewer: Schema.Struct({ harness: Schema.String, model: Schema.String, sessionID: Schema.String }),
  independence: Schema.Literals(["independent", "same-model"]),
  /** Optional: a round that ended without a verdict is a valid record, and is not a pass. */
  verdict: Schema.optional(Schema.Literals(["LGTM", "NEEDS_WORK"])),
  findings: Schema.Array(Finding),
  round: Schema.Number,
})

export type Record = typeof Record_.Type
export type Finding = typeof Finding.Type

/**
 * Validates an already-parsed record.
 *
 * Separate from the schema because the interesting rules are cross-field — a
 * blocking finding without a location, a round below 1 — and a closed schema
 * cannot express those. Every failure names a reason rather than returning a bare
 * false, because the consumer has to be able to tell "no review yet" from "a
 * review that does not count".
 */
export function validate(input: unknown): Result.Result<Record, Reason> {
  const decoded = Effect.runSync(
    Effect.result(
      Schema.decodeUnknownEffect(Record_, {
        errors: "all",
        // Closed: a typo, or a field added later and silently ignored, is the
        // failure mode this whole module exists to prevent.
        onExcessProperty: "error",
        propertyOrder: "original",
      })(input),
    ),
  )
  if (Result.isFailure(decoded)) return Result.fail(Reason.malformed)
  const record = decoded.success

  if (!FULL_SHA.test(record.headSHA)) return Result.fail(Reason.headNotFullSha)
  if (!FULL_SHA.test(record.base)) return Result.fail(Reason.baseNotFullSha)
  if (!SAFE_ID.test(record.reviewer.sessionID)) return Result.fail(Reason.reviewerSessionInvalid)
  if (!Number.isInteger(record.round) || record.round < 1) return Result.fail(Reason.roundInvalid)
  for (const finding of record.findings) {
    if (finding.line === undefined) {
      // An advisory finding may legitimately be about a design or a test gap, which
      // has no location. A blocking one that cannot be pointed at cannot be fixed.
      if (finding.severity === "blocking") return Result.fail(Reason.findingLineMissing)
      continue
    }
    if (finding.line < 1) return Result.fail(Reason.findingLineInvalid)
  }
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
  if (Result.isFailure(validated))
    return Effect.succeed(refuse(validated.failure, `${source}: ${validated.failure}`))
  return Effect.succeed({ ok: true, record: validated.success, source })
}

/**
 * Maps a record onto the merge driver's evidence shape.
 *
 * Three rules, all deliberate:
 *   - the verdict's SHA is the record's `headSHA`, the only sha the verdict covers
 *   - `independence` travels with the verdict so a same-model review is visible as
 *     such downstream. A policy knob will later decide whether same-model is
 *     enough; the data has to exist before anything can decide it.
 *   - a record with no verdict yields no `reviewVerdict` at all, rather than a
 *     passing one. "The reviewer replied without a token" is not an approval.
 *
 * Gates, CI and mergeBase are left absent: they are the driver's to measure.
 */
export function toMergeEvidence(record: Record): PublishDrivers.MergeEvidence {
  return {
    headSHA: record.headSHA,
    reviewVerdict:
      record.verdict === undefined
        ? undefined
        : {
            verdict: record.verdict,
            sha: record.headSHA,
            independence: record.independence,
            reviewerSessionID: record.reviewer.sessionID,
          },
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
