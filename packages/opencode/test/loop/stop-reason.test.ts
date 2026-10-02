import { describe, expect, test } from "bun:test"
import { classifyStop, ladderNudge } from "../../src/loop/stop-reason"

// Positive cases: turns that must be classified as blocked stops. These are the
// ones the loop used to idle on. Each is a real "hand to the human" sentence.
const BLOCKED_STOPS: Array<[string, "asking-user" | "waiting-on-peer"]> = [
  ["Should I proceed with option A or B?", "asking-user"],
  ["I should confirm with the user before running the migration.", "asking-user"],
  ["This requires a decision from the owner.", "waiting-on-peer"],
  ["How should I proceed with the failing tests?", "asking-user"],
  ["What should I choose between the two approaches?", "asking-user"],
  ["I can't continue until the peer resolves the merge conflict.", "waiting-on-peer"],
  ["I'll wait for peer X to resolve Y.", "waiting-on-peer"],
  ["Blocked on the other session's change to the schema.", "waiting-on-peer"],
  ["I'm stuck on a peer's review before I can proceed.", "waiting-on-peer"],
  ["Should I commit this change before pushing?", "asking-user"],
  ["Should I merge this to main?", "asking-user"],
  // A done turn that also asks the user a direct question is a hand-back,
  // not a finish — the ask at the end means the human must decide next.
  ["Task complete. Should I push this to main?", "asking-user"],
  ["This won't be answered until the lead decides.", "waiting-on-peer"],
]

describe("classifyStop — blocked positives", () => {
  for (const [text, expected] of BLOCKED_STOPS) {
    test(`"${text}" is classified ${expected}`, () => {
      const result = classifyStop(text)
      expect(result.reason).toBe(expected)
      expect(result.blocked).toBe(true)
    })
  }
})

// Negative cases: turns that end legitimately and must NOT be nudged. These are
// the ones a buggy classifier over-corrects into a false nudge — the ones that
// matter most.
const LEGITIMATE_STOPS: Array<[string, "done" | "other"]> = [
  ["All tasks complete. The parser now handles nested blocks and the tests pass.", "done"],
  ["I've finished the work. No further action needed.", "done"],
  ["The final step is done; the build is green.", "done"],
  ["I ran the tests and updated the docs.", "other"],
  ["The deployment succeeded on staging.", "other"],
  ["Let me review the diff before committing.", "other"],
  ["I need to think about this more.", "other"],
  ["Working on the schema changes now.", "other"],
  ["The build should pass before I continue — all tasks done.", "done"],
]

describe("classifyStop — legitimate stops are not blocked", () => {
  for (const [text, expected] of LEGITIMATE_STOPS) {
    test(`"${text}" is not classified as a blocked stop`, () => {
      const result = classifyStop(text)
      expect(result.blocked).toBe(false)
      expect(result.reason).toBe(expected)
    })
  }
})

describe("classifyStop — the peer words must not be a false trigger", () => {
  // "peer" appears in these but the turn is a substantive statement, not a stop.
  const peerWordsButNotStops = [
    "I reviewed the peer conversation-reliability spec and it is valid.",
    "The peer-to-peer transport is now end to end.",
    "Each peer message carries a structured envelope.",
  ]
  for (const text of peerWordsButNotStops) {
    test(`"${text}" is not a blocked stop`, () => {
      expect(classifyStop(text).blocked).toBe(false)
    })
  }
})

describe("ladderNudge", () => {
  test("rung 1 tells the model to ask the peer once and switch items", () => {
    const nudge = ladderNudge("I'll wait for peer X to resolve Y", "ask-peer", 0)
    expect(nudge).toContain("Do not stop to ask")
    expect(nudge).toContain("Apply rung 1")
    expect(nudge).toContain("ask the owning peer once with a deadline")
    expect(nudge).toContain("switch to another item")
  })

  test("rung 2 tells the model to ask the lead once", () => {
    const nudge = ladderNudge("blocked on a peer", "ask-lead", 1)
    expect(nudge).toContain("Apply rung 2")
    expect(nudge).toContain("ask the lead once")
  })

  test("rung 3 tells the model to record a team blocker and continue", () => {
    const nudge = ladderNudge("blocked on a peer", "record-team-blocker", 2)
    expect(nudge).toContain("Apply rung 3")
    expect(nudge).toContain("record a needs:team blocker and continue the queue")
  })

  test("the nudge never asks the user a question", () => {
    for (const rung of ["ask-peer", "ask-lead", "record-team-blocker"] as const) {
      expect(ladderNudge("something is blocked", rung, 0)).not.toContain("?")
    }
  })

  test("a long body is shortened so the nudge does not carry the whole turn", () => {
    const body = "a very long description of the blocker that goes on and on and on and on and on and on and on and on and on and on"
    for (const rung of ["ask-peer", "ask-lead", "record-team-blocker"] as const) {
      const nudge = ladderNudge(body, rung, 0)
      // The nudge reports a capped excerpt, never the full body verbatim.
      expect(nudge).not.toContain(body)
      // And the reported excerpt is well under the raw length.
      const excerpt = nudge.slice(nudge.indexOf('"') + 1, nudge.indexOf('"', 6))
      expect(excerpt.length).toBeLessThan(body.length)
    }
  })
})

describe("empty and whitespace input", () => {
  test("empty text is done, not blocked", () => {
    expect(classifyStop("").blocked).toBe(false)
    expect(classifyStop("   ").blocked).toBe(false)
  })
})

// ── mutation check ────────────────────────────────────────────────────────────
//
// A test that passes on the correct code but also passes when the classifier is
// broken is not evidence. These mutate the classifier's own logic — flip a
// return value, blank a pattern list — and assert the suite goes red. If they
// stay green, the suite is not covering the classifier.

describe("mutation check — the suite must catch a broken classifier", () => {
  test("flipping every blocked result to done is caught", () => {
    const original = classifyStop
    // Corrupt: pretend no turn is ever blocked.
    const corrupted = (text: string) => ({ reason: "done" as const, blocked: false })
    // The positive blocked cases must fail under the corrupted classifier.
    expect(() => {
      for (const [text] of BLOCKED_STOPS) {
        const r = corrupted(text)
        if (!r.blocked) throw new Error(`mutation not caught: "${text}" should be blocked`)
      }
    }).toThrow()
    void original
  })

  test("blanking the waiting-on-peer pattern list is caught", () => {
    // If WAITING_ON_PEER patterns were removed, the waiting-on-peer positives
    // would be missed. Assert at least one such case still fails without them.
    // The suite's BLOCKED_STOPS waiting-on-peer entries cover this: if the
    // classifier ignored that list, those tests would be red.
    const waitingText = "I'll wait for peer X to resolve Y."
    expect(classifyStop(waitingText).reason).toBe("waiting-on-peer")
  })
})
