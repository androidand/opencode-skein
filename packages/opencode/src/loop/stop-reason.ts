// Classify the output text a loop iteration ended with, so the loop can
// escalate instead of idling.
//
// The loop used to treat every turn that stopped without a tool call the same:
// a substantive answer, a turn that asked the user a question, and a turn that
// said "I'll wait for peer X" all fell through to either ending the run or
// burning the no-progress budget. This module tells them apart. It is pure and
// import-free on purpose, same as ./continuation and ./similarity: loop.ts
// imports SessionPrompt, so anything prompt.ts might also want must not route
// through loop.ts (see ./similarity.ts for the boot crash that cycle caused).
//
// It never performs an action. It only ever classifies a stop and, for a
// blocked stop, produces the ladder nudge text that tells the model which rung
// to apply — the action is always the loop's, on this module's word.

export type StopReason = "asking-user" | "waiting-on-peer" | "done" | "other"

export interface StopClassification {
  reason: StopReason
  /** True when the turn ended with no tool calls and text asking for someone. */
  blocked: boolean
}

// A turn that ends the model asking the user a direct question, or asking the
// user to pick between options, or asking permission to proceed. These read as
// "hand to the human" and must be nudged to decide from the specs instead.
const ASKING_USER = [
  /\bshould I (proceed|continue|go|start|move|send|call|run)\b/i,
  /\b(I should|I'd|we should|we'd) (ask|check|confirm|get|verify)\b/i,
  /\b(a|the) user (needs to|should|must|decides?|picks?|approves?)\b/i,
  /\b(I can't|I cannot|I am stuck|I'm stuck) (without|until|before)\b/i,
  /\bhow (should|do I) (proceed|handle|approach|deal with)\b/i,
  /\bwhat (should I|do I|will I) (do|proceed|choose|pick|try|handle)\b/i,
  /\boption[sa-z]? (A|B|C|\d)\b/i,
  /\b(a|the|my) question is?\b/i,
  /\bdo I (need to|have to|should)\b/i,
]

// A turn that ends waiting on a peer, a blocker, or an external dependency. The
// loop's whole reason to exist is that these should not stop the run.
const WAITING_ON_PEER = [
  /\b(wait(ing|ed)? for|await(ing|ed)?)\b.*\b(peer|collaborator|member|another session|the lead|the owner)\b/i,
  /\b(blocked on|waiting on|stuck on)\b.*\b(peer|member|session|the other side|collaborator)\b/i,
  /\bwon't (be |able to )?(respond|reply|answer|answered|act|respond back)\b/i,
  /\bcan't (continue|proceed|move forward|make progress) (without|until|before)\b/i,
  /\b(this requires|that requires|it requires|we need|they need)\b/i,
  /\bhold(ing|s|ed)? (up|until|on)\b/i,
  /\bneed (to )?(ask|wait for|contact|ping)\b.*\b(peer|member|session|the lead)\b/i,
  /\bdeferred to\b/i,
  /\bresolve\b.*\bbefore\b.*\b(I |we |proceed|continue|move)\b/i,
  /\bthe other (side|session|agent)\b/i,
]

const DONE = [
  /\b(done|complete|finished|completed)\b.*\b(all |the |this )?task/i,
  /\b(all |every )?tasks? (are|complete|finished|done)\b/i,
  /\bno (further|more) (work|action|tasks?)?\b/i,
  /\b(the |a )?(final|last) (step|item|task|part)\b/i,
]

// The ladder rung a blocked stop should apply. The loop owns the send; this
// names the rung so the nudge is a stable, testable string.
export type LadderRung = "ask-peer" | "ask-lead" | "record-team-blocker"

/**
 * Classify a turn's ending text. `blocked` is true only for a turn that asks
 * the user for a decision or says it is waiting on a peer — exactly the turns
 * the ladder exists to escalate. Everything else is `done` or `other` and the
 * loop leaves it alone.
 */
export function classifyStop(text: string): StopClassification {
  if (text.trim().length === 0) {
    return { reason: "done", blocked: false }
  }
  if (matches(ASKING_USER, text)) {
    return { reason: "asking-user", blocked: true }
  }
  if (matches(WAITING_ON_PEER, text)) {
    return { reason: "waiting-on-peer", blocked: true }
  }
  if (matches(DONE, text)) {
    return { reason: "done", blocked: false }
  }
  return { reason: "other", blocked: false }
}

function matches(patterns: readonly RegExp[], text: string): boolean {
  for (const pattern of patterns) {
    if (pattern.test(text)) return true
  }
  return false
}

/**
 * The ladder nudge for a blocked stop at rung N. It never asks the user anything
 * and never stops the run; it tells the model to apply the next rung and move on.
 * `applied` counts how many times this stop has already been nudged, so the loop
 * can bound it (3 per item per the spec) and then record a blocker instead.
 */
export function ladderNudge(text: string, rung: LadderRung, applied: number): string {
  const next = rung === "ask-peer" ? "ask the owning peer once with a deadline, then switch to another item"
    : rung === "ask-lead" ? "ask the lead once, then continue the queue"
    : "record a needs:team blocker and continue the queue"
  const body = shorten(text)
  const prefix = `Do not stop to ask. Previous turn said "${body}" — ${applied === 0 ? "Apply rung 1: " : rung === "ask-lead" ? "Apply rung 2: " : "Apply rung 3: "}`
  return `${prefix}${next}.`
}

// Cut the reported body so the nudge stays short and the model can re-read the
// tail if it needs context. The cap is well below any realistic turn, so every
// long body is shortened and every short body is reported verbatim.
function shorten(text: string): string {
  const first = text.trim().replace(/\s+/g, " ")
  const cap = 50
  return first.length > cap ? first.slice(0, cap - 3) + "..." : first
}

export const StopReasonClassify = { classifyStop, ladderNudge }
