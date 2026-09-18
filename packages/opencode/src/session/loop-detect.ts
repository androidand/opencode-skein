// Pure decision logic for "is this turn a repeat of the last one" — split out
// of prompt.ts's runLoop so the two ways a turn can be stuck (near-identical
// text with no tool calls, or the exact same tool call repeated) are testable
// without the surrounding Effect/DB machinery. Mirrors the style of
// session/peers.ts: pure and import-free apart from types and the shared
// bigram-similarity helper, which is itself zero-import by design.
import { similarity } from "@/loop/similarity"

export interface ToolCallPart {
  tool: string
  input: Record<string, unknown>
}

/**
 * A stable signature for the tool call(s) a turn made, or undefined when the
 * turn made none. Object keys are sorted before stringifying so the same
 * arguments in a different key order still compare equal — models don't
 * reliably preserve key order across otherwise-identical retries.
 */
export function toolCallSignature(parts: readonly ToolCallPart[]): string | undefined {
  if (parts.length === 0) return undefined
  return parts.map((p) => `${p.tool}:${JSON.stringify(p.input, Object.keys(p.input).sort())}`).join("|")
}

export interface TurnSnapshot {
  text: string
  toolSignature: string | undefined
}

export type RepeatResult = { repeated: false } | { repeated: true; kind: "text" | "tool"; similarity?: number }

/**
 * Whether `current` is a repeat of `last`. A turn with tool calls is only
 * ever compared against another turn's tool calls (exact signature match);
 * a turn with no tool calls is only ever compared against another turn's
 * text (bigram similarity). The two are never cross-compared — switching
 * from calling tools to producing plain text (or back) is a change in
 * trajectory, not evidence of one, even if it turns out not to be progress
 * either.
 */
export function detectRepeat(current: TurnSnapshot, last: TurnSnapshot | undefined, threshold: number): RepeatResult {
  if (last === undefined) return { repeated: false }

  if (current.toolSignature !== undefined) {
    if (last.toolSignature !== undefined && current.toolSignature === last.toolSignature) {
      return { repeated: true, kind: "tool" }
    }
    return { repeated: false }
  }

  if (last.toolSignature !== undefined) return { repeated: false }

  const sim = similarity(current.text, last.text)
  if (sim >= threshold) return { repeated: true, kind: "text", similarity: sim }
  return { repeated: false }
}

export * as LoopDetect from "./loop-detect"
