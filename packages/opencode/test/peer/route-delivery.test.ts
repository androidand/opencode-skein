// Prompting a session another opencode process is driving would run its turn
// in the wrong process: its own TUI never sees it and two processes race on
// one session. Since the messaging roster went machine-wide, a target with no
// registered address has to be refused rather than prompted locally.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { deliverToOpencodeSession } from "../../src/peer/route"

describe("deliverToOpencodeSession ownership guard", () => {
  let dir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "route-delivery-test-"))
    await mkdir(join(dir, "sessions"), { recursive: true })
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    await rm(dir, { recursive: true, force: true })
  })

  const deliver = (owned: boolean, local: () => Effect.Effect<void>) =>
    deliverToOpencodeSession({
      targetSessionID: "ses_target",
      fromSessionID: "ses_sender",
      fromName: "sender",
      text: "hello",
      owned,
      local,
    })

  test("a session this process owns is prompted in process", async () => {
    let prompted = 0
    const outcome = await Effect.runPromise(deliver(true, () => Effect.sync(() => void prompted++)))
    expect(outcome.via).toBe("local")
    expect(prompted).toBe(1)
  })

  test("an unregistered session this process does not own is refused, not prompted", async () => {
    let prompted = 0
    const outcome = await Effect.runPromise(deliver(false, () => Effect.sync(() => void prompted++)))
    expect(outcome.via).toBe("unaddressable")
    expect(prompted).toBe(0)
  })
})
