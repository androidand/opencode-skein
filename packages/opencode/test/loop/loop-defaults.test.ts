// The SDK and the server each declare the loop defaults, and the server cannot
// import the SDK, so the two are kept in step by hand. That hand-kept step
// drifted once: `fix-loop-stall` raised the server's DefaultNoProgressLimit
// from 10 to 15 and did not touch the SDK copy. It stayed invisible because
// both front-ends send the value explicitly (cli/cmd/loop.ts yargs `default:`,
// and the TUI through parseLoopArgs), so the server's `?? Default…` fallback is
// unreachable in normal use and the server default was decoration.
//
// This test is the check that was missing. It reads both files as text rather
// than importing either, which is what lets it compare two modules that cannot
// import each other, and it throws rather than passing on a partial match when
// a default is renamed or removed.
import { describe, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import { join } from "path"

// this file is packages/opencode/test/loop/loop-defaults.test.ts
const repoRoot = join(import.meta.dir, "../../../..")

const SDK_DEFAULTS = join(repoRoot, "packages/sdk/js/src/v2/loop-args.ts")
const SERVER_LOOP = join(repoRoot, "packages/opencode/src/loop/loop.ts")
const COMPLETION = join(repoRoot, "packages/opencode/src/loop/completion.ts")

/** Reads `name: <number>,` out of the SDK's exported defaults object. */
function sdkNumber(source: string, name: string) {
  const match = source.match(new RegExp(`\\b${name}:\\s*(\\d+)\\b`))
  if (!match) throw new Error(`could not find numeric field "${name}" in loop-args.ts`)
  return Number(match[1])
}

/** Reads `export const Name = <number>` out of the server loop module. */
function serverNumber(source: string, name: string) {
  const match = source.match(new RegExp(`export const ${name} = (\\d+)\\b`))
  if (!match) throw new Error(`could not find exported const "${name}" in loop.ts`)
  return Number(match[1])
}

/** Reads the completion token literal, which completion.ts owns. */
function completionToken(source: string) {
  const match = source.match(/export const DEFAULT_COMPLETION_TOKEN = "([^"]+)"/)
  if (!match) throw new Error("could not find DEFAULT_COMPLETION_TOKEN in completion.ts")
  return match[1]
}

describe("loop defaults stay in step between the SDK and the server", () => {
  test("noProgressLimit matches, so the stall fix reaches real users", async () => {
    const [sdk, server] = await Promise.all([readFile(SDK_DEFAULTS, "utf8"), readFile(SERVER_LOOP, "utf8")])
    // Named keys so a failure says which side moved, rather than a bare
    // `expected 15, received 10` that reads as though one number were canonical.
    // The server side is expected deliberately: the SDK copy drifted, since the
    // server cannot import the SDK, and it is the copy the CLI and TUI send.
    const serverValue = serverNumber(server, "DefaultNoProgressLimit")
    expect({ "loop-args.ts": sdkNumber(sdk, "noProgressLimit"), "loop.ts": serverValue }).toEqual({
      "loop-args.ts": serverValue,
      "loop.ts": serverValue,
    })
  })

  test("both sides were found, not one side defaulted", async () => {
    // Guards the failure mode where a regex stops matching and the helper
    // throws, turning a silent drift into a confusing error — or worse, where a
    // helper is loosened until it matches anything. A missing field must throw,
    // not read as a value.
    const [sdk, server] = await Promise.all([readFile(SDK_DEFAULTS, "utf8"), readFile(SERVER_LOOP, "utf8")])
    expect(() => sdkNumber(sdk, "noProgressLimit")).not.toThrow()
    expect(() => sdkNumber(sdk, "noSuchField")).toThrow(/could not find/)
    expect(() => serverNumber(server, "DefaultNoProgressLimit")).not.toThrow()
    expect(() => serverNumber(server, "NoSuchConst")).toThrow(/could not find/)
  })

  test("positive control: the comparison fails on drifted input", async () => {
    // The equality check above must be able to go red. Take the real SDK
    // source, drift the value the way the original bug did, and assert the same
    // comparison now reports a mismatch. Without this, a green first test is
    // consistent with a comparison that cannot fail — a regex that matches
    // nothing, or one loosened until it matches anything.
    const [sdk, server] = await Promise.all([readFile(SDK_DEFAULTS, "utf8"), readFile(SERVER_LOOP, "utf8")])
    const serverValue = serverNumber(server, "DefaultNoProgressLimit")
    const compare = (source: string) => ({
      "loop-args.ts": sdkNumber(source, "noProgressLimit"),
      "loop.ts": serverValue,
    })
    const expected = { "loop-args.ts": serverValue, "loop.ts": serverValue }
    // Drift the SDK copy, so this exercises the comparison above.
    const drifted = sdk.replace(/noProgressLimit:\s*\d+/, `noProgressLimit: ${serverValue - 5}`)
    expect(compare(drifted)).not.toEqual(expected)
    expect(compare(sdk)).toEqual(expected)
  })

  test("the SDK default is not a dead fallback: front-ends send it explicitly", async () => {
    // The reason the drift above was invisible. If the front-ends stopped
    // sending noProgressLimit, the server default would start mattering and
    // this file's comment about it would be wrong. Assert the send, on both
    // surfaces that exist.
    const [cli, tui] = await Promise.all([
      readFile(join(repoRoot, "packages/opencode/src/cli/cmd/loop.ts"), "utf8"),
      readFile(join(repoRoot, "packages/tui/src/component/prompt/index.tsx"), "utf8"),
    ])
    // CLI: yargs resolves the default from the shared constant and sends it.
    expect(cli).toMatch(/default:\s*LoopArgDefaults\.noProgressLimit/)
    // TUI: goes through parseLoopArgs, so it inherits LoopArgDefaults. Assert
    // the call rather than the field, so an unrelated mention cannot pass it.
    expect(tui).toMatch(/parseLoopArgs/)
  })

  test("maxIterations and intervalSeconds match", async () => {
    const [sdk, server] = await Promise.all([readFile(SDK_DEFAULTS, "utf8"), readFile(SERVER_LOOP, "utf8")])
    // Named keys here too, for the same reason: a bare pair of numbers does not
    // say which default moved.
    expect({
      max: sdkNumber(sdk, "maxIterations"),
      interval: sdkNumber(sdk, "intervalSeconds"),
    }).toEqual({
      max: serverNumber(server, "DefaultMaxIterations"),
      interval: serverNumber(server, "DefaultIntervalSeconds"),
    })
  })

  test("the completion token is one string, not two drifting copies", async () => {
    const [sdk, completion] = await Promise.all([readFile(SDK_DEFAULTS, "utf8"), readFile(COMPLETION, "utf8")])
    // completion.ts owns the literal; the SDK mirrors it because the SDK cannot
    // import from the server. That mirrored copy can drift, and it decides what
    // the CLI and TUI actually send.
    const token = completionToken(completion)
    expect(sdk).toContain(`completionToken: "${token}"`)
  })

  test("loop.ts re-exports the token rather than restating it", async () => {
    // The server side is safe because it aliases the import rather than
    // copying the string. A literal here would be a second unchecked copy.
    const server = await readFile(SERVER_LOOP, "utf8")
    expect(server).toContain("export const COMPLETE_SIGNAL = DEFAULT_COMPLETION_TOKEN")
  })
})