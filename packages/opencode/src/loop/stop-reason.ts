// Why a turn ended without finishing the work.
//
// A turn with no further tool calls ends the iteration, and "ended" covers very
// different things: finished, stuck, or — the case that costs the most — stopped to
// ask the user something or to wait on a peer. The loop used to treat the last two
// like the model going quiet: burn the no-progress budget, or end the run, and wait
// for a human who was never going to answer inside the run.
//
// This reads the END of the output and says which of those it was, so the next
// prompt can tell the model what to do instead. It only ever produces a nudge; it
// never acts. A wrong classification costs one unneeded sentence in a prompt, which
// is why precision matters more than recall here and the negatives in the tests are
// the ones that count: a summary that happens to contain a question mark must not
// read as a stop.
//
// Import-free on purpose, same as ./continuation and ./completion — loop.ts imports
// SessionPrompt, so anything prompt.ts might also want must not route through loop.ts
// (see ./similarity.ts for the boot crash that cycle caused).

export type StopReason = "asking-user" | "waiting-on-peer" | "other"

// Only the last paragraph can be the model's closing ask. Earlier paragraphs are
// reasoning, and a question there that the model went on to answer is not a stop.
const TailChars = 700

const WAITING_ON_PEER: readonly RegExp[] = [
  /\b(waiting|wait) (on|for) (the )?(peer|other (agent|session)|another (agent|session)|session|colleague)\b/,
  /\b(blocked|blocking) (on|by) (the )?(peer|another|other|session|agent|\w+['’]s)\b/,
  /\b(can(?:not|['’]?t)|unable to) (continue|proceed|go on|move on)( with this)? until\b/,
  /\buntil (the )?(peer|\w+) (finishes|resolves|replies|responds|has (finished|resolved|replied))\b/,
  /\b(has|have) the responsibility (of|for)\b/,
  /\bowns? (the|this) (blocker|task|change|fix)\b.*\b(can(?:not|['’]?t)|need to wait)\b/,
]

const ASKING_USER: readonly RegExp[] = [
  /\b(should|shall|would you like me to|do you want me to|would you prefer|want me to)\b[^.!]*\?/,
  /\b(which|what) (option|approach|one|way)\b[^.!]*\?/,
  /\b(let me know|tell me) (if|whether|how|which|what|when)\b/,
  /\b(please )?(confirm|clarify|advise)\b[^.!]*(before|so that|so i)/,
  /\bbefore i (proceed|continue|go ahead|push|commit|merge)\b/,
  /\b(waiting|wait|awaiting) (for )?(your|the user['’]?s?) (input|approval|confirmation|response|decision|go[- ]ahead|answer)\b/,
  /\b(need|require)s? (your|the user['’]?s?) (input|approval|confirmation|decision|go[- ]ahead)\b/,
  /\bcheck (this |that |it )?with (my|the) user\b/,
  /\bask (my|the) user\b/,
  /\bhand(ing)? (this |it )?(back|over) to (you|the user)\b/,
  /\bhow would you like (me )?to\b/,
  /\byour call\b/,
]

function lastParagraph(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return ""
  const paragraphs = trimmed.split(/\n\s*\n/)
  const last = paragraphs[paragraphs.length - 1] ?? ""
  return last.length > TailChars ? last.slice(-TailChars) : last
}

/**
 * A closing summary — a list, a heading, a code block — is not a question put to a
 * person, even when a line in it ends with "?". Questions put to the user are prose.
 */
function looksLikeSummary(paragraph: string): boolean {
  const lines = paragraph.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length === 0) return false
  const structured = lines.filter((line) => /^\s*([-*•]|\d+[.)]|#{1,6}\s|```|\|)/.test(line)).length
  return structured / lines.length > 0.5
}

export function classifyStop(output: string): StopReason {
  const paragraph = lastParagraph(output)
  if (paragraph.length === 0) return "other"
  if (looksLikeSummary(paragraph)) return "other"
  const text = paragraph.toLowerCase()
  if (WAITING_ON_PEER.some((pattern) => pattern.test(text))) return "waiting-on-peer"
  // A bare trailing question mark is not enough on its own ("Did that work?" in a
  // narrative), so an ask needs one of the phrasings above AND to be at the end.
  if (ASKING_USER.some((pattern) => pattern.test(text))) return "asking-user"
  return "other"
}

/**
 * The sentence prepended to the next prompt. It carries the whole ladder in the
 * shortest form that works on a small local model: do not stop, decide, and use the
 * user only for what truly needs a person. The loop's existing budgets (the strike
 * count in queue mode, the no-progress limit in prompt mode) bound how often this
 * can repeat, so it needs no counter of its own.
 */
export function ladderNudge(reason: StopReason): string | undefined {
  if (reason === "asking-user") {
    return [
      "Your last turn ended by asking your user a question. Your user is not available and will not answer inside this run.",
      "Decide from the change's proposal, design and specs, note the decision in tasks.md, and continue with a tool call.",
      "Only if the question truly needs a human — credentials, an unclear goal, anything irreversible — write it to the change's",
      ".skein/blocker.md and move on to the next item. Do not stop to ask.",
    ].join(" ")
  }
  if (reason === "waiting-on-peer") {
    return [
      "Your last turn ended by waiting on a peer. Do not wait. Continue with another item that is not blocked.",
      "If you still need the peer's answer, send ONE request to the lead (not another message to the peer),",
      "record what you are waiting on in the change's .skein/blocker.md, and carry on.",
    ].join(" ")
  }
  return undefined
}
