import { describe, expect, test } from "bun:test"
import { confirmLead, type ConfirmDeps } from "../../src/peer/lead-confirm"

const deps = (over: Partial<ConfirmDeps>): ConfirmDeps => ({
  platform: "darwin",
  dialog: () => undefined,
  tty: () => undefined,
  ...over,
})

describe("confirmLead", () => {
  test("a clicked approval on the dialog confirms", () => {
    expect(confirmLead("m", deps({ dialog: () => "Make lead" }))).toEqual({ ok: true, via: "dialog" })
  })
  test("cancelling the dialog refuses and does NOT fall through to the terminal", () => {
    let asked = false
    const result = confirmLead("m", deps({ dialog: () => "Cancel", tty: () => ((asked = true), "yes") }))
    expect(result.ok).toBe(false)
    expect(asked).toBe(false)
  })
  test("a dialog that cannot be shown falls back to a typed yes", () => {
    expect(confirmLead("m", deps({ tty: () => "yes\n" }))).toEqual({ ok: true, via: "tty" })
  })
  test("anything but yes on the terminal refuses", () => {
    expect(confirmLead("m", deps({ tty: () => "y" })).ok).toBe(false)
    expect(confirmLead("m", deps({ tty: () => "" })).ok).toBe(false)
  })
  test("no dialog and no terminal refuses — the plain model-shell case", () => {
    const result = confirmLead("m", deps({}))
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("no way to ask a person") })
  })
  test("off macOS the dialog is never tried", () => {
    let tried = false
    confirmLead("m", deps({ platform: "linux", dialog: () => ((tried = true), "Make lead"), tty: () => undefined }))
    expect(tried).toBe(false)
  })
})
