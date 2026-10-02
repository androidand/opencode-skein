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


// Real files on disk, because the reader's job is to be honest about what is
// actually written — a fixture validated in memory would not exercise the paths,
// the JSON parse, or the "file is absent" case that a merge waits on.

const HEAD = "a".repeat(40)
const OTHER = "b".repeat(40)

const VALID: ReviewRecord.Record = {
  headSHA: HEAD,
  base: OTHER,
  reviewer: { harness: "opencode", model: "some-other-family" },
  independence: "independent",
  verdict: "LGTM",
  reviewedSHA: HEAD,
  findings: [{ file: "src/x.ts", line: 12, severity: "advisory", text: "consider naming this" }],
  round: 1,
}

async function withRecord(contents: unknown | string) {
  const dir = await mkdtemp(path.join(tmpdir(), "review-record-"))
  await mkdir(path.join(dir, ".skein"), { recursive: true })
  if (contents !== undefined)
    await writeFile(path.join(dir, ".skein", "review.json"), typeof contents === "string" ? contents : JSON.stringify(contents))
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
    expect(await reasonOf({ ...VALID, headSHA: "abc1234", reviewedSHA: "abc1234" })).toBe(
      ReviewRecord.Reason.headNotFullSha,
    )
  })

  test("a verdict with no reviewedSHA is refused", async () => {
    // The most dangerous shape this record can take: it reads as an approval and
    // covers nothing.
    const { reviewedSHA: _dropped, ...withoutSha } = VALID
    expect(await reasonOf(withoutSha)).toBe(ReviewRecord.Reason.verdictNotForHead)
  })

  test("a verdict for a different SHA is refused", async () => {
    // A stale review: LGTM for an earlier commit must not cover the new head.
    expect(await reasonOf({ ...VALID, reviewedSHA: OTHER })).toBe(ReviewRecord.Reason.verdictNotForHead)
  })

  test("a record with no verdict at all is valid", async () => {
    // A round that ended without a verdict is a real outcome worth recording. What
    // matters is that it does not become a pass, which the mapper tests pin.
    const { verdict: _v, reviewedSHA: _s, ...noVerdict } = VALID
    const result = await load(await withRecord(noVerdict))
    expect(result.ok).toBe(true)
  })

  test("a finding with an unknown severity is refused", async () => {
    expect(
      await reasonOf({ ...VALID, findings: [{ file: "x", line: 1, severity: "nit", text: "t" }] }),
    ).toBe(ReviewRecord.Reason.malformed)
  })

  test("every named reason is distinct", () => {
    // If two refusals collapsed to one token, a caller could not tell them apart
    // and a log could not be alerted on them separately.
    expect(new Set(Object.values(ReviewRecord.Reason)).size).toBe(Object.values(ReviewRecord.Reason).length)
  })
})

describe("mapping onto the merge driver's evidence", () => {
  test("the verdict carries the record's headSHA", () => {
    // Never `reviewedSHA`: validate has already proven they are equal, and the
    // driver should not have to know that.
    const evidence = ReviewRecord.toMergeEvidence(VALID)
    expect(evidence.headSHA).toBe(HEAD)
    expect(evidence.reviewVerdict).toEqual({ verdict: "LGTM", sha: HEAD })
  })

  test("no verdict yields no reviewVerdict at all, not a passing one", () => {
    // The whole point: "the reviewer replied without a token" is not an approval.
    const { verdict: _v, reviewedSHA: _s, ...noVerdict } = VALID
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
    const { verdict: _v, reviewedSHA: _s, ...noVerdict } = VALID
    const refusal = PublishDrivers.mayMerge({
      policy: POLICY,
      target: "dev",
      actor: "integrator",
      evidence: {
        ...ReviewRecord.toMergeEvidence(noVerdict),
        mergeBase: "b".repeat(40),
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
        mergeBase: "b".repeat(40),
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
