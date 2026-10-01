import { describe, expect, test } from "bun:test"
import { classifyStop, ladderNudge } from "@/loop/stop-reason"

describe("classifyStop — the stops that end up on the user's desk", () => {
  const asking = [
    "I've implemented the parser. Should I also update the docs, or leave that for a follow-up?",
    "Tests pass. Would you like me to push this branch now?",
    "Done with the refactor.\n\nBefore I proceed with the migration, can you confirm which option you prefer?",
    "I need your approval before I merge.",
    "Ah, I have to check this with my user first.",
    "Which approach do you want? Let me know and I'll continue.",
    "I'm waiting for your input on the naming.",
    "Handing this back to you for a decision.",
  ]
  for (const text of asking) {
    test(`asking: ${text.slice(0, 50)}`, () => expect(classifyStop(text)).toBe("asking-user"))
  }

  const waiting = [
    "Peer alpha has the responsibility of blocker Y, so I cannot continue until that is solved.",
    "I'm blocked on the other session's migration, waiting for peer to finish.",
    "Waiting on another agent to land the schema change; I can't proceed until it merges.",
    "This depends on session B. I cannot continue until it replies.",
  ]
  for (const text of waiting) {
    test(`waiting: ${text.slice(0, 50)}`, () => expect(classifyStop(text)).toBe("waiting-on-peer"))
  }
})

describe("classifyStop — negatives matter more than positives", () => {
  const other = [
    "",
    "   \n\n  ",
    "All 14 tasks are checked off and the suite passes.",
    "I fixed the bug. The cause was an off-by-one in the cursor. Tests: 12 pass.",
    // A question mark inside reasoning that the model then answered, with a plain closing line.
    "Should the cursor be inclusive? I checked the spec: it is.\n\nI changed it and the tests pass.",
    // A summary list where one line is phrased as a question.
    "Summary:\n- Added the guard\n- Why does it hang? Traced to the unawaited promise\n- Tests pass\n- Pushed",
    "```\nshould we retry?\n```",
    "Running the tests now.",
    "The reviewer asked whether the cursor should be inclusive; I answered yes in the PR.",
    "Next I will commit and push the branch.",
  ]
  for (const text of other) {
    test(`not a stop: ${JSON.stringify(text.slice(0, 50))}`, () => expect(classifyStop(text)).toBe("other"))
  }

  test("only the closing paragraph counts: an early ask that was answered is not a stop", () => {
    const text = "Would you like me to also bump the version?\n\nI decided yes because the spec requires it, and did.\n\nDone."
    expect(classifyStop(text)).toBe("other")
  })

  test("a very long output is judged on its tail, not its head", () => {
    const text = "Should I do this?\n\n" + "work log line\n".repeat(400) + "\nAll done."
    expect(classifyStop(text)).toBe("other")
  })
})

test("a single huge closing paragraph is judged on its tail: an old question at its head is not a stop", () => {
  const text = "Should I do this? " + "The change is applied and verified. ".repeat(80) + "All tasks complete."
  expect(text.length).toBeGreaterThan(1500)
  expect(classifyStop(text)).toBe("other")
})

describe("ladderNudge", () => {
  test("a user ask is told to decide from the specs and use the user only for what needs a human", () => {
    const text = ladderNudge("asking-user")!
    expect(text).toContain("Decide from")
    expect(text).toContain(".skein/blocker.md")
    expect(text).toContain("Do not stop to ask")
  })
  test("a peer wait is told to keep working and send ONE request to the lead, never another to the peer", () => {
    const text = ladderNudge("waiting-on-peer")!
    expect(text).toContain("ONE request to the lead")
    expect(text).toContain("not another message to the peer")
  })
  test("other stops get no nudge", () => expect(ladderNudge("other")).toBeUndefined())
})
