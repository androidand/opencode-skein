import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

// The tool text is an instruction every session reads. It used to end with "say that to
// your own user", which combined with "send once" taught agents to message a peer once and
// then hand the blocker to the human. It must now describe the ladder, and must still carry
// every rule that exists because of the 2026-09-18 message storm.
const src = join(import.meta.dir, "../../src/tool")
const text = readFileSync(join(src, "send-peer-message.txt"), "utf8")
const code = readFileSync(join(src, "send-peer-message.ts"), "utf8")

describe("send_peer_message guidance", () => {
  test("no longer sends a blocked agent straight to its user", () => {
    expect(text).not.toContain("say that to your own user rather than asking the peer again")
    expect(code).not.toContain("say so \" +\n                \"to your own user instead of asking the peer again")
    expect(text).toContain("Your user is the last step, not the first")
  })

  test("describes the ladder: keep working, one request to the lead, record the blocker, user last", () => {
    for (const phrase of ["Carry on with", "ONE request to the lead", ".skein/blocker.md", "needs a\nhuman"]) {
      expect(text).toContain(phrase)
    }
    expect(code).toContain("ONE request to the")
    expect(code).toContain(".skein/blocker.md")
  })

  test("keeps every anti-storm rule", () => {
    for (const phrase of [
      "send once and move on",
      "do not ask a peer whether it is done",
      "do not loop over a list of targets",
      "twice in a row is refused",
      "you must not send \"are you done?\" follow-ups",
    ]) {
      expect(text).toContain(phrase)
    }
    expect(code).toContain("Do not resend and do")
    expect(code).toContain("not poll")
  })
})
