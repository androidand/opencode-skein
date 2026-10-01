import { describe, expect, test } from "bun:test"
import { confirmLead, showDialog, type ConfirmDeps, type RunResult, type Runner } from "../../src/peer/lead-confirm"

const deps = (over: Partial<ConfirmDeps>): ConfirmDeps => ({
  platform: "darwin",
  dialog: () => "unavailable",
  tty: () => undefined,
  ...over,
})

describe("confirmLead", () => {
  test("an approved dialog confirms", () => {
    expect(confirmLead("m", deps({ dialog: () => "approve" }))).toEqual({ ok: true, via: "dialog" })
  })
  test("a declined dialog refuses and does NOT fall through to the terminal", () => {
    let asked = false
    const result = confirmLead("m", deps({ dialog: () => "decline", tty: () => ((asked = true), "yes") }))
    expect(result.ok).toBe(false)
    expect(asked).toBe(false)
  })
  test("an unavailable dialog falls back to a typed yes", () => {
    expect(confirmLead("m", deps({ tty: () => "yes\n" }))).toEqual({ ok: true, via: "tty" })
  })
  test("anything but yes on the terminal refuses", () => {
    expect(confirmLead("m", deps({ tty: () => "y" })).ok).toBe(false)
    expect(confirmLead("m", deps({ tty: () => "" })).ok).toBe(false)
  })
  test("no dialog and no terminal refuses — the plain model-shell case", () => {
    expect(confirmLead("m", deps({}))).toEqual({ ok: false, reason: expect.stringContaining("no way to ask a person") })
  })
})

const ok = (stdout = "", status: number | null = 0, stderr = ""): RunResult => ({ status, stdout, stderr, missing: false })
const missing: RunResult = { status: null, stdout: "", stderr: "", missing: true }
type Call = { command: string; args: string[]; env?: Record<string, string> }
function runner(answers: Record<string, RunResult>, calls: Call[] = []): Runner {
  return (command, args, env) => {
    calls.push({ command, args, env })
    return answers[command] ?? missing
  }
}

describe("showDialog — macOS", () => {
  test("approve, decline, and cancel", () => {
    expect(showDialog("m", "darwin", {}, runner({ osascript: ok("button returned:Make lead, gave up:false") }))).toBe("approve")
    expect(showDialog("m", "darwin", {}, runner({ osascript: ok("button returned:Cancel, gave up:false") }))).toBe("decline")
    expect(showDialog("m", "darwin", {}, runner({ osascript: ok("", 1, "execution error: User canceled. (-128)") }))).toBe("decline")
  })
  test("a timeout (empty button) is a decline, never an approval", () => {
    expect(showDialog("m", "darwin", {}, runner({ osascript: ok("button returned:, gave up:true") }))).toBe("decline")
  })
  test("osascript missing or failing for another reason is unavailable", () => {
    expect(showDialog("m", "darwin", {}, runner({}))).toBe("unavailable")
    expect(showDialog("m", "darwin", {}, runner({ osascript: ok("", 1, "no window server") }))).toBe("unavailable")
  })
  test("quotes and backslashes in the message are escaped inside the AppleScript literal", () => {
    const calls: Call[] = []
    showDialog('x" & (do shell script "id") & "', "darwin", {}, runner({ osascript: ok("button returned:Cancel") }, calls))
    expect(calls[0].args[1]).toContain('\\"')
    expect(calls[0].args[1]).not.toContain('"x" & (do shell')
  })
})

describe("showDialog — Windows", () => {
  test("Yes approves; anything else declines; default button is No", () => {
    const calls: Call[] = []
    expect(showDialog("m", "win32", {}, runner({ "powershell.exe": ok("Yes\r\n") }, calls))).toBe("approve")
    expect(showDialog("m", "win32", {}, runner({ "powershell.exe": ok("No\r\n") }))).toBe("decline")
    expect(calls[0].args.join(" ")).toContain("'No'")
  })
  test("the message travels in the environment, not in the script", () => {
    const calls: Call[] = []
    showDialog("evil'; calc; '", "win32", {}, runner({ "powershell.exe": ok("No") }, calls))
    expect(calls[0].env?.OC_LEAD_MSG).toBe("evil'; calc; '")
    expect(calls[0].args.join(" ")).not.toContain("calc")
  })
  test("PowerShell missing or failing is unavailable", () => {
    expect(showDialog("m", "win32", {}, runner({}))).toBe("unavailable")
    expect(showDialog("m", "win32", {}, runner({ "powershell.exe": ok("", 1) }))).toBe("unavailable")
  })
})

describe("showDialog — Linux", () => {
  test("no display means nobody to ask: unavailable, and nothing is even tried", () => {
    const calls: Call[] = []
    expect(showDialog("m", "linux", {}, runner({ zenity: ok() }, calls))).toBe("unavailable")
    expect(calls).toHaveLength(0)
  })
  test("zenity: 0 approves, 1 and timeout 5 decline", () => {
    const env = { DISPLAY: ":0" }
    expect(showDialog("m", "linux", env, runner({ zenity: ok("", 0) }))).toBe("approve")
    expect(showDialog("m", "linux", env, runner({ zenity: ok("", 1) }))).toBe("decline")
    expect(showDialog("m", "linux", env, runner({ zenity: ok("", 5) }))).toBe("decline")
  })
  test("Wayland-only sessions count as having a display", () => {
    expect(showDialog("m", "linux", { WAYLAND_DISPLAY: "wayland-0" }, runner({ zenity: ok("", 0) }))).toBe("approve")
  })
  test("zenity missing falls back to kdialog", () => {
    const env = { DISPLAY: ":0" }
    expect(showDialog("m", "linux", env, runner({ kdialog: ok("", 0) }))).toBe("approve")
    expect(showDialog("m", "linux", env, runner({ kdialog: ok("", 1) }))).toBe("decline")
  })
  test("a broken zenity (unexpected status) falls through rather than approving or declining", () => {
    expect(showDialog("m", "linux", { DISPLAY: ":0" }, runner({ zenity: ok("", 255) }))).toBe("unavailable")
  })
  test("neither installed is unavailable", () => {
    expect(showDialog("m", "linux", { DISPLAY: ":0" }, runner({}))).toBe("unavailable")
  })
  test("the message is passed as an argument, never through a shell", () => {
    const calls: Call[] = []
    showDialog("$(id)", "linux", { DISPLAY: ":0" }, runner({ zenity: ok("", 1) }, calls))
    expect(calls[0].args).toContain("$(id)")
  })
})
