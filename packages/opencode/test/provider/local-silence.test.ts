import { describe, expect, test } from "bun:test"
import {
  estimatePromptTokens,
  LOCAL_PREFILL_FLOOR_TOKENS_PER_SECOND,
  LOCAL_SILENCE_CEILING_MS,
  promptSilenceFloorMs,
  raiseDefaultForPrompt,
} from "../../src/provider/local-silence"

// z4, 2026-10-15: an 80k-token compaction prompt spent 217 s in prefill, silent,
// against a 120 s default chunk timeout. Every attempt was killed, the backend
// dropped the connection, and the retry started the prefill over.
const MEASURED_PREFILL_SECONDS = 217
const DEFAULT_CHUNK_TIMEOUT_MS = 120_000

// A JSON body of ~80k tokens (3 chars per token is the estimator's convention).
const bigBody = "x".repeat(79_643 * 3)

describe("prompt-aware silence floor", () => {
  test("the measured 80k-token prefill fits inside the floor, the old default did not", () => {
    expect(MEASURED_PREFILL_SECONDS * 1000).toBeGreaterThan(DEFAULT_CHUNK_TIMEOUT_MS)
    expect(promptSilenceFloorMs(bigBody)).toBeGreaterThan(MEASURED_PREFILL_SECONDS * 1000)
  })

  test("the assumed prefill rate is more pessimistic than anything measured (370-550 tok/s)", () => {
    expect(LOCAL_PREFILL_FLOOR_TOKENS_PER_SECOND).toBeLessThan(370)
  })

  test("a small prompt gets only a small margin, so a genuinely stuck stream is still caught quickly", () => {
    expect(promptSilenceFloorMs('{"messages":[{"role":"user","content":"hi"}]}')).toBeLessThan(65_000)
  })

  test("it never exceeds the host-paced ceiling", () => {
    expect(promptSilenceFloorMs("x".repeat(500_000_000))).toBe(LOCAL_SILENCE_CEILING_MS)
  })

  test("no body, no opinion", () => {
    expect(promptSilenceFloorMs(undefined)).toBe(0)
    expect(estimatePromptTokens("")).toBe(0)
  })
})

describe("raiseDefaultForPrompt", () => {
  test("a DEFAULT timeout is raised to what the prompt needs", () => {
    expect(raiseDefaultForPrompt(DEFAULT_CHUNK_TIMEOUT_MS, true, bigBody)).toBeGreaterThan(MEASURED_PREFILL_SECONDS * 1000)
  })

  test("an operator-configured timeout is never touched, even when the prompt is huge", () => {
    expect(raiseDefaultForPrompt(30_000, false, bigBody)).toBe(30_000)
  })

  test("it only ever raises: a larger existing allowance (host-paced) stays", () => {
    expect(raiseDefaultForPrompt(1_800_000, true, bigBody)).toBe(1_800_000)
    expect(raiseDefaultForPrompt(DEFAULT_CHUNK_TIMEOUT_MS, true, "tiny")).toBe(DEFAULT_CHUNK_TIMEOUT_MS)
  })
})
