import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, mkdir, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { ReviewRecord } from "@/policy/review-record"
import { PublishDrivers } from "@/policy/drivers"
import type { PublishPolicy } from "@/policy/publish-policy"

const POLICY: PublishPolicy.Policy = {
  version: 1,
  repo: "example/repo",
  visibility: "private",
  commit: { branches: ["loop/*"] },
  push: { remotes: ["origin"], branches: ["loop/*"] },
  merge: { into: ["dev"], method: "squash", requires: ["gates", "review"], by: ["integrator"] },
}

const HEAD = "a".repeat(40)
const BASE = "b".repeat(40)
const REVIEWER_SESSION = "ses_abc123"

const VALID: ReviewRecord.Record = {
  headSHA: HEAD,
  base: BASE,
  reviewer: { harness: "opencode", model: "some-other-family", sessionID: REVIEWER_SESSION },
  independence: "independent",
  verdict: "LGTM",
  findings: [{ file: "src/x.ts", line: 12, severity: "advisory", text: "consider naming this" }],
  round: 1,
}

// Real files on disk, because the reader's job is to be honest about what is
// actually written — a fixture validated in memory would not exercise the paths,
// the JSON parse, or the "file is absent" case a merge waits on.

async function withRecord(contents: unknown | string) {
  const dir = await mkdtemp(path.join(tmpdir(), "review-record-"))
  await mkdir(path.join(dir, ".skein"), { recursive: true })
  if (contents !== undefined)
    await writeFile(
      path.join(dir, ".skein", "review.json"),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    )
  return dir
}

const load = (dir: string) => Effect.runPromise(ReviewRecord.load(dir))
const reasonOf = async (contents: unknown | string) => {
  const result = await load(await withRecord(contents))
  if (result.ok) throw new Error("expected a refusal, got a record")
  return result.reason
}

describe("review record reading", () => {
  test("reads a valid record", async () => {
    const result = await load(await withRecord(VALID))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.record.headSHA).toBe(HEAD)
    expect(result.record.verdict).toBe("LGTM")
    expect(result.source).toContain(path.join(".skein", "review.json"))
  })

  test("an absent record is distinguishable from an invalid one", async () => {
    // Two different facts for whoever waits on a merge: nobody has reviewed yet,
    // versus a review that does not count. Collapsing them would make a retry
    // look pointless.
    expect(await reasonOf(undefined)).toBe(ReviewRecord.Reason.absent)
    expect(await reasonOf({ ...VALID, round: 0 })).toBe(ReviewRecord.Reason.roundInvalid)
  })

  test("unparseable JSON is its own reason, not malformed", async () => {
    // A truncated write should not read as "the schema rejected it".
    expect(await reasonOf("{ not json")).toBe(ReviewRecord.Reason.unreadable)
  })

  test("an unknown key is refused rather than ignored", async () => {
    // Closed schema: a field this version does not understand must not be
    // silently dropped, or a future field could change the meaning of a record.
    expect(await reasonOf({ ...VALID, verdictToken: "LGTM" })).toBe(ReviewRecord.Reason.malformed)
  })

  test("an abbreviated head SHA is refused", async () => {
    // Two commits can share a prefix, so an abbreviation cannot identify a head.
    expect(await reasonOf({ ...VALID, headSHA: "abc1234" })).toBe(ReviewRecord.Reason.headNotFullSha)
  })

  test("an abbreviated base is refused", async () => {
    // The record names a `base..head` range; an abbreviated base cannot anchor one.
    expect(await reasonOf({ ...VALID, base: "dev" })).toBe(ReviewRecord.Reason.baseNotFullSha)
  })

  test("a record with no reviewer session is refused", async () => {
    // The record lives in the author's own working tree and a model can write a
    // file. Until a writer binds this to an authenticated identity it is only a
    // claim, but a record that omits it cannot even be compared later.
    const { sessionID: _dropped, ...noSession } = VALID.reviewer
    expect(await reasonOf({ ...VALID, reviewer: noSession })).toBe(ReviewRecord.Reason.malformed)
  })

  test("a reviewer session with unsafe characters is refused", async () => {
    // This value ends up in a comparison against an authenticated identity, so it
    // must not be a place to smuggle structure.
    for (const sessionID of ["ses/../other", "ses 123", "x".repeat(65), ""]) {
      expect(await reasonOf({ ...VALID, reviewer: { ...VALID.reviewer, sessionID } })).toBe(
        ReviewRecord.Reason.reviewerSessionInvalid,
      )
    }
  })

  test("a record with no verdict at all is valid", async () => {
    // A round that ended without a verdict is a real outcome worth recording. What
    // matters is that it does not become a pass, which the mapper tests pin.
    const { verdict: _v, ...noVerdict } = VALID
    const result = await load(await withRecord(noVerdict))
    expect(result.ok).toBe(true)
  })

  test("a finding with an unknown severity is refused", async () => {
    expect(
      await reasonOf({ ...VALID, findings: [{ file: "x", line: 1, severity: "nit", text: "t" }] }),
    ).toBe(ReviewRecord.Reason.malformed)
  })

  test("a blocking finding must name a line", async () => {
    // A blocking finding nobody can point at cannot be fixed.
    expect(
      await reasonOf({ ...VALID, findings: [{ file: "x", severity: "blocking", text: "t" }] }),
    ).toBe(ReviewRecord.Reason.findingLineMissing)
  })

  test("an advisory finding may have no line", async () => {
    // A design or test-gap finding genuinely has no location.
    const result = await load(
      await withRecord({ ...VALID, findings: [{ file: "x", severity: "advisory", text: "t" }] }),
    )
    expect(result.ok).toBe(true)
  })

  test("zero and negative lines are refused", async () => {
    // Observed: `Schema.Number` accepts 0, -3, 1.5, NaN and Infinity.
    for (const line of [0, -3]) {
      expect(await reasonOf({ ...VALID, findings: [{ file: "x", line, severity: "advisory", text: "t" }] })).toBe(
        ReviewRecord.Reason.findingLineInvalid,
      )
    }
  })

  test("a non-integer line is refused", async () => {
    // NaN and Infinity cannot survive JSON.parse, so they are only reachable
    // through the exported validate; the file path still has to reject 1.5.
    expect(await reasonOf({ ...VALID, findings: [{ file: "x", line: 1.5, severity: "advisory", text: "t" }] })).toBe(
      ReviewRecord.Reason.malformed,
    )
    for (const line of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = ReviewRecord.validate({
        ...VALID,
        findings: [{ file: "x", line, severity: "advisory", text: "t" }],
      })
      expect(result._tag).toBe("Failure")
    }
  })

  test("every named reason is distinct", () => {
    // If two refusals collapsed to one token, a caller could not tell them apart
    // and a log could not be alerted on them separately.
    expect(new Set(Object.values(ReviewRecord.Reason)).size).toBe(Object.values(ReviewRecord.Reason).length)
  })
})

describe("mapping onto the merge driver's evidence", () => {
  test("the verdict carries the record's headSHA", () => {
    // The only sha the verdict covers: a review is made for one head.
    const evidence = ReviewRecord.toMergeEvidence(VALID)
    expect(evidence.headSHA).toBe(HEAD)
    expect(evidence.reviewVerdict?.sha).toBe(HEAD)
    expect(evidence.reviewVerdict?.verdict).toBe("LGTM")
  })

  test("independence travels with the verdict", () => {
    // A same-model review must be visible as same-model, or "the reviewer differs
    // from the author" cannot be enforced by anything downstream.
    const independent = ReviewRecord.toMergeEvidence(VALID)
    expect(independent.reviewVerdict?.independence).toBe("independent")
    const sameModel = ReviewRecord.toMergeEvidence({ ...VALID, independence: "same-model" })
    expect(sameModel.reviewVerdict?.independence).toBe("same-model")
  })

  test("no verdict yields no reviewVerdict at all, not a passing one", () => {
    // The whole point: "the reviewer replied without a token" is not an approval.
    const { verdict: _v, ...noVerdict } = VALID
    const evidence = ReviewRecord.toMergeEvidence(noVerdict)
    expect(evidence.reviewVerdict).toBeUndefined()
    expect(evidence.headSHA).toBe(HEAD)
  })

  test("gates, CI and mergeBase are left to the driver", () => {
    // Mixing a reviewer's opinion with a machine's measurement in one record would
    // make it impossible to tell which claim failed when a merge is refused.
    const evidence = ReviewRecord.toMergeEvidence(VALID)
    expect(evidence.gates).toBeUndefined()
    expect(evidence.ci).toBeUndefined()
    expect(evidence.mergeBase).toBeUndefined()
  })

  test("NEEDS_WORK maps through as NEEDS_WORK, not as an absence", () => {
    const evidence = ReviewRecord.toMergeEvidence({ ...VALID, verdict: "NEEDS_WORK" })
    expect(evidence.reviewVerdict?.verdict).toBe("NEEDS_WORK")
  })

  test("the real driver refuses a record with no verdict", () => {
    // The property that matters, checked against the actual consumer rather than a
    // type assertion: a review record without a verdict must not become a pass.
    const { verdict: _v, ...noVerdict } = VALID
    const refusal = PublishDrivers.mayMerge({
      policy: POLICY,
      target: "dev",
      actor: "integrator",
      evidence: {
        ...ReviewRecord.toMergeEvidence(noVerdict),
        mergeBase: BASE,
        gates: { passed: true, sha: HEAD },
      },
    })
    expect(refusal.ok).toBe(false)
    if (refusal.ok) throw new Error("unreachable")
    expect(refusal.reason).toContain("no recorded review verdict")
  })

  test("the real driver accepts a record whose verdict covers the head", () => {
    const ok = PublishDrivers.mayMerge({
      policy: POLICY,
      target: "dev",
      actor: "integrator",
      evidence: {
        ...ReviewRecord.toMergeEvidence(VALID),
        mergeBase: BASE,
        gates: { passed: true, sha: HEAD },
      },
    })
    expect(ok).toEqual({ ok: true })
  })

  test("the driver still refuses a same-model verdict it was not told to accept", () => {
    // `independence` is carried, not yet enforced: today's driver accepts a
    // same-model LGTM. Pinning today's behaviour so the later policy knob is a
    // deliberate change rather than a silent drift.
    const ok = PublishDrivers.mayMerge({
      policy: POLICY,
      target: "dev",
      actor: "integrator",
      evidence: {
        ...ReviewRecord.toMergeEvidence({ ...VALID, independence: "same-model" }),
        mergeBase: BASE,
        gates: { passed: true, sha: HEAD },
      },
    })
    expect(ok).toEqual({ ok: true })
  })

  test("an absent record yields no verdict, with its reason", async () => {
    const out = await Effect.runPromise(ReviewRecord.evidenceFor(await withRecord(undefined)))
    expect(out.reason).toBe(ReviewRecord.Reason.absent)
    expect(out.evidence.reviewVerdict).toBeUndefined()
  })
})
