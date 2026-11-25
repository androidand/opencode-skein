import { describe, expect, test } from "bun:test"
import { consecutiveOverflowCompactions } from "@/session/prompt"

type Msg = { info: Record<string, unknown>; parts: Record<string, unknown>[] }

const emptyBuild: Msg = {
  info: { role: "assistant", mode: "build", tokens: { output: 0 } },
  parts: [],
}
const overflowCompaction: Msg = {
  info: { role: "user" },
  parts: [{ type: "compaction", auto: true, overflow: true }],
}
const summary: Msg = {
  info: { role: "assistant", mode: "compaction", tokens: { output: 2268 } },
  parts: [{ type: "text", text: "summary" }],
}
const answered: Msg = {
  info: { role: "assistant", mode: "build", tokens: { output: 340 } },
  parts: [{ type: "text", text: "done" }],
}

const count = (messages: Msg[]) => consecutiveOverflowCompactions(messages as never)

describe("prompt.consecutiveOverflowCompactions", () => {
  test("no messages means no overflow run", () => {
    expect(count([])).toBe(0)
  })

  test("counts overflow compactions, skipping empty turns, summaries and continue prompts", () => {
    // newest first, as sessions.messages returns them
    expect(count([emptyBuild, summary, overflowCompaction, emptyBuild, summary, overflowCompaction])).toBe(2)
  })

  test("a completed turn ends the run", () => {
    expect(count([emptyBuild, summary, overflowCompaction, answered, overflowCompaction])).toBe(1)
  })

  test("a non-overflow compaction ends the run", () => {
    const manual: Msg = { info: { role: "user" }, parts: [{ type: "compaction", auto: false }] }
    expect(count([emptyBuild, summary, overflowCompaction, manual, overflowCompaction])).toBe(1)
  })
})
