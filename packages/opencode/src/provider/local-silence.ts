/**
 * How long a local backend may legitimately say NOTHING before the client may
 * call the stream dead.
 *
 * A local llama.cpp backend streams no byte until prefill finishes, and prefill
 * time scales with the prompt. Measured on a 48 GB W7800 serving a 27B Q8:
 * 79,643 prompt tokens took 217 s to process (370 tokens/s, falling as the
 * context deepens), and every request behind it in the single slot waited as
 * long again. A fixed 120 s chunk timeout therefore killed every large prompt —
 * the compaction of a long session above all, which sends the whole history —
 * the backend dropped the connection (llama-skein logs it as `EOF` / 503), the
 * retry restarted the prefill from zero, and the session "compacted forever".
 *
 * The floor is derived from the request, not guessed per host: estimated prompt
 * tokens divided by a deliberately pessimistic prefill rate. It only ever RAISES
 * the silence allowance, and a user-configured chunkTimeout always wins (the
 * caller applies it only to the default).
 */

/** Pessimistic prefill throughput (tokens/s). Measured hosts sustain 370–550. */
export const LOCAL_PREFILL_FLOOR_TOKENS_PER_SECOND = 150

/** Margin on top of the prefill estimate: queueing behind another request, first-token latency. */
export const LOCAL_PREFILL_MARGIN_MS = 60_000

/** Never wait longer than the host-paced ceiling: past this the backend really is stuck. */
export const LOCAL_SILENCE_CEILING_MS = 1_800_000

/** JSON request bodies run ~3 characters per token for mixed code/prose: an over-estimate on purpose. */
const CHARS_PER_TOKEN = 3

export function estimatePromptTokens(body: string | undefined): number {
  if (!body) return 0
  return Math.ceil(body.length / CHARS_PER_TOKEN)
}

/** Minimum silence (ms) a request of this body may take before its first byte. 0 = no opinion. */
export function promptSilenceFloorMs(body: string | undefined): number {
  const tokens = estimatePromptTokens(body)
  if (tokens <= 0) return 0
  const ms = Math.ceil((tokens / LOCAL_PREFILL_FLOOR_TOKENS_PER_SECOND) * 1000) + LOCAL_PREFILL_MARGIN_MS
  return Math.min(ms, LOCAL_SILENCE_CEILING_MS)
}

/**
 * The silence allowance to use for one request: `current` (already floored for
 * host-paced placement) raised to what this prompt's own size needs — but only
 * when `current` is a default. A value the operator configured is theirs.
 */
export function raiseDefaultForPrompt(current: number, isDefault: boolean, body: string | undefined): number {
  if (!isDefault) return current
  return Math.max(current, promptSilenceFloorMs(body))
}
