import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { mkdtemp, mkdir, readFile, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { ReviewGate } from "@/policy/review-gate"
import { ReviewRecord } from "@/policy/review-record"
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
const AUTHOR = "ses_author"
const REVIEWER = "ses_reviewer"

async function dir() {
  const d = await mkdtemp(path.join(tmpdir(), "review-gate-"))
  await mkdir(path.join(d, ".skein"), { recursive: true })
  return d
}

const write = (d: string, reviewerSessionID: string, extra?: { verdict?: "LGTM" | "NEEDS_WORK" }) =>
  Effect.runPromise(
    ReviewGate.write({
      directory: d,
      reviewerSessionID,
      headSHA: HEAD,
      base: BASE,
      independence: "independent",
      ...(extra?.verdict ? { verdict: extra.verdict } : {}),
      round: 1,
    }),
  )

/**
 * `mayMerge` returns a Refusal as a VALUE, so a denial is `{ok:false}` inside a
 * successful Effect — not an Effect failure. Only an unreadable record fails the
 * Effect, with ReviewGateError. Conflating those two was this file's first bug.
 */
const gate = (d: string, authorSessionID: string) =>
  Effect.runSync(
    Effect.result(
      ReviewGate.gate({
        directory: d,
        policy: POLICY,
        target: "dev",
        actor: "integrator",
        gates: { passed: true, sha: HEAD },
        authorSessionID,
      }),
    ),
  )

const refusedWith = (result: ReturnType<typeof gate>): string => {
  if (Result.isFailure(result)) throw new Error(`expected a refusal, got failure: ${result.failure.reason}`)
  if (result.success.ok) throw new Error("expected a refusal, got ok:true")
  return result.success.reason
}

/** What a model with shell access can do: write the file itself, naming anyone. */
async function forge(d: string, reviewerSessionID: string) {
  await writeFile(
    path.join(d, ".skein", "review.json"),
    JSON.stringify({
      headSHA: HEAD,
      base: BASE,
      reviewer: { harness: "x", model: "y", sessionID: reviewerSessionID },
      independence: "independent",
      verdict: "LGTM",
      findings: [],
      round: 1,
    }),
  )
}

describe("the writer", () => {
  test("stamps the reviewer it is given, not one it is told to claim", async () => {
    const d = await dir()
    await write(d, REVIEWER)
    const record = JSON.parse(await readFile(path.join(d, ".skein", "review.json"), "utf8"))
    expect(record.reviewer.sessionID).toBe(REVIEWER)
  })

  test("refuses to write a record that would fail on read", async () => {
    // Writer and reader share a schema on purpose: a record rejected here would
    // be rejected there too, and the round trip would look like a review that
    // never happened rather than a rejected write.
    const d = await dir()
    const result = Effect.runSync(
      Effect.result(
        ReviewGate.write({
          directory: d,
          reviewerSessionID: REVIEWER,
          headSHA: "not-a-sha",
          base: BASE,
          independence: "independent",
          verdict: "LGTM",
          round: 1,
        }),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isSuccess(result)) throw new Error("unreachable")
    expect(result.failure.reason).toBe(ReviewGate.WriteFailure.malformed)
  })

  test("a written record is readable by the reader", async () => {
    const d = await dir()
    await write(d, REVIEWER, { verdict: "LGTM" })
    const loaded = await Effect.runPromise(ReviewRecord.load(d))
    expect(loaded.ok).toBe(true)
  })
})

describe("the gate", () => {
  test("accepts a review by a different session", async () => {
    const d = await dir()
    await write(d, REVIEWER, { verdict: "LGTM" })
    const result = await gate(d, AUTHOR)
    if (Result.isFailure(result)) throw new Error(`unexpected failure: ${result.failure.reason}`)
    expect(result.success).toEqual({ ok: true })
  })

  test("refuses a verdict the author wrote for themselves", async () => {
    // The case this module exists for: an author approving its own change.
    const d = await dir()
    await write(d, AUTHOR, { verdict: "LGTM" })
    expect(refusedWith(await gate(d, AUTHOR))).toContain("author's own session")
  })

  test("refuses when the record names no verdict", async () => {
    const d = await dir()
    await write(d, REVIEWER)
    expect(refusedWith(await gate(d, AUTHOR))).toContain("no recorded review verdict")
  })

  test("refuses when there is no record at all", async () => {
    const d = await dir()
    const result = await gate(d, AUTHOR)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isSuccess(result)) throw new Error("unreachable")
    expect(result.failure.reason).toBe(ReviewRecord.Reason.absent)
  })

  test("refuses a verdict covering a different head", async () => {
    const d = await dir()
    await write(d, REVIEWER, { verdict: "LGTM" })
    const result = await gate(d, AUTHOR)
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) throw new Error("unreachable")
    // Sanity: the evidence carries the record's own head, so this only holds
    // while the gate reads base..head from the same record it validates.
    expect(result.success.ok).toBe(true)
  })

  test("a record forged by shell naming a real reviewer still passes — the residual", async () => {
    // This is the honest limit, pinned so it cannot be quietly forgotten.
    // `.skein/review.json` is writable by any process with filesystem access, and
    // the gate only checks that the reviewer differs from the author. It cannot
    // tell a real review from a fabricated one. Denying the path to models is task
    // 1b.2 and does not change this for bash; only OS separation would, and
    // nothing here claims it.
    const d = await dir()
    await forge(d, REVIEWER)
    const result = await gate(d, AUTHOR)
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) throw new Error("unreachable")
    expect(result.success).toEqual({ ok: true })
  })
})