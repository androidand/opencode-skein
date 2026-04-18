import { expect, test } from "bun:test"

const { formatNotificationSequence, notifyTerminal, resolveNotificationMethod, sanitizeNotificationText } =
  await import("../../../src/cli/cmd/tui/util/notify")
const { wrapOscSequence } = await import("../../../src/cli/cmd/tui/util/osc")

test("resolveNotificationMethod picks osc9 for iTerm", () => {
  expect(resolveNotificationMethod("auto", { TERM_PROGRAM: "iTerm.app" })).toBe("osc9")
})

test("resolveNotificationMethod picks osc777 for kitty and bell for vscode", () => {
  expect(resolveNotificationMethod("auto", { KITTY_WINDOW_ID: "1" })).toBe("osc777")
  expect(resolveNotificationMethod("auto", { TERM_PROGRAM: "vscode" })).toBe("bell")
})

test("sanitizeNotificationText removes controls and semicolons", () => {
  expect(sanitizeNotificationText("hello;\nworld\x07")).toBe("hello: world")
})

test("formatNotificationSequence emits osc9 and osc777 payloads", () => {
  expect(formatNotificationSequence({ method: "osc9", title: "OpenCode", body: "Response ready" })).toBe(
    "\x1b]9;OpenCode: Response ready\x07",
  )
  expect(formatNotificationSequence({ method: "osc777", title: "OpenCode", body: "Permission required" })).toBe(
    "\x1b]777;notify;OpenCode;Permission required\x07",
  )
})

test("wrapOscSequence escapes OSC sequences for passthrough", () => {
  expect(wrapOscSequence("\x1b]9;done\x07", { TMUX: "/tmp/tmux" })).toBe("\x1bPtmux;\x1b\x1b]9;done\x07\x1b\\")
})

test("notifyTerminal writes the resolved sequence", () => {
  let output = ""
  expect(
    notifyTerminal({
      title: "OpenCode",
      body: "Question asked",
      method: "auto",
      env: { TERM_PROGRAM: "ghostty" },
      write: (chunk) => {
        output += chunk
      },
    }),
  ).toBe(true)
  expect(output).toBe("\x1b]9;OpenCode: Question asked\x07")
})
