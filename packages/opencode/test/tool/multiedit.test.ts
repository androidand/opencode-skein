import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { MultiEditTool } from "../../src/tool/multiedit"
import { Truncate, Tool } from "../../src/tool"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-multiedit-session"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Format.defaultLayer,
    Bus.layer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const init = Effect.fn("MultiEditToolTest.init")(function* () {
  const info = yield* MultiEditTool
  return yield* info.init()
})

const run = Effect.fn("MultiEditToolTest.run")(function* (
  args: Tool.InferParameters<typeof MultiEditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

describe("tool.multiedit", () => {
  it.live("applies multiple edits to the same file in sequence", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const filePath = path.join(dir, "file.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "alpha\nbeta\ngamma\n", "utf-8"))

        yield* run({
          filePath,
          edits: [
            { oldString: "alpha", newString: "delta" },
            { oldString: "gamma", newString: "omega" },
          ],
        })

        const content = yield* Effect.promise(() => fs.readFile(filePath, "utf-8"))
        expect(content).toBe("delta\nbeta\nomega\n")
      }),
    ),
  )
})
