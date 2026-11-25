// Regression: an inbound peer message to a session whose crew loop had
// already finished was handed to that finished loop, which refused it, and
// the message was then dropped without a trace. A session that ran a loop to
// completion and went idle could never be reached by a peer again.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Loop } from "@/loop/loop"
import { deliverToLoop } from "../../../src/peer/claude/loop-route"

type Status = Loop.Status

function fakeLoop(loops: { id: string; sessionID: string; status: Status }[]) {
  const inboxed: { loopID: string; text: string }[] = []
  const svc = {
    list: () => Effect.succeed(loops as unknown as Loop.Info[]),
    inbox: (input: { loopID: string; text: string }) =>
      Effect.sync(() => {
        const l = loops.find((x) => x.id === input.loopID)
        // Mirrors loop.ts: only running or paused loops accept messages.
        if (!l || (l.status !== "running" && l.status !== "paused")) return false
        inboxed.push({ loopID: input.loopID, text: input.text })
        return true
      }),
  } as unknown as Pick<Loop.Interface, "list" | "inbox">
  return { svc, inboxed }
}

const inbound = { sessionID: "ses_target", text: "next task please" }

describe("deliverToLoop", () => {
  test("a finished loop does not swallow the message", async () => {
    const { svc, inboxed } = fakeLoop([{ id: "loop_done", sessionID: "ses_target", status: "completed" }])
    const taken = await Effect.runPromise(deliverToLoop(svc, inbound))
    expect(taken).toBe(false)
    expect(inboxed).toHaveLength(0)
  })

  test("a running loop takes the message into its inbox", async () => {
    const { svc, inboxed } = fakeLoop([{ id: "loop_live", sessionID: "ses_target", status: "running" }])
    const taken = await Effect.runPromise(deliverToLoop(svc, inbound))
    expect(taken).toBe(true)
    expect(inboxed).toEqual([{ loopID: "loop_live", text: "next task please" }])
  })

  test("a paused loop takes the message", async () => {
    const { svc } = fakeLoop([{ id: "loop_paused", sessionID: "ses_target", status: "paused" }])
    expect(await Effect.runPromise(deliverToLoop(svc, inbound))).toBe(true)
  })

  test("an active loop wins over an older finished one for the same session", async () => {
    const { svc, inboxed } = fakeLoop([
      { id: "loop_old", sessionID: "ses_target", status: "completed" },
      { id: "loop_new", sessionID: "ses_target", status: "running" },
    ])
    expect(await Effect.runPromise(deliverToLoop(svc, inbound))).toBe(true)
    expect(inboxed[0]?.loopID).toBe("loop_new")
  })

  test("another session's loop is ignored", async () => {
    const { svc } = fakeLoop([{ id: "loop_other", sessionID: "ses_other", status: "running" }])
    expect(await Effect.runPromise(deliverToLoop(svc, inbound))).toBe(false)
  })
})
