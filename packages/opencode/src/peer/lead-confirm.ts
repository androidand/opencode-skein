// A human-presence check for `lead set`.
//
// Ancestry identifies WHICH session is being designated, but a shell command a
// model runs inside that session has the same ancestry as one the user typed, so
// the command alone cannot prove a person asked for it. Something the model's
// shell cannot answer has to stand between the command and the file.
//
//   1. A native dialog (macOS). A shell can start it but cannot click it without
//      accessibility rights nobody granted it.
//   2. Failing that, a typed confirmation read from the controlling terminal.
//      This is a speed bump rather than a wall: a model that allocates its own
//      pty feeds both ends. It is still worth having because the plain case — a
//      shell with no terminal at all — is the one models actually produce.
//   3. Neither available: refuse. The caller offers `--no-confirm` for the user
//      who has accepted that a model in the same session could set it too.
//
// Everything that touches the machine is injected, so each branch is testable
// and the failure branches are observed failing rather than assumed.
import { spawnSync } from "child_process"
import { closeSync, openSync, readSync, writeSync } from "fs"

export type ConfirmResult = { ok: true; via: "dialog" | "tty" } | { ok: false; reason: string }

export interface ConfirmDeps {
  platform: NodeJS.Platform
  /** Runs the dialog; returns the clicked button, or undefined when it could not be shown. */
  dialog: (message: string) => string | undefined
  /** Asks on the controlling terminal; undefined when there is none. */
  tty: (message: string) => string | undefined
}

const APPROVE = "Make lead"

export function confirmLead(message: string, deps: ConfirmDeps): ConfirmResult {
  if (deps.platform === "darwin") {
    const button = deps.dialog(message)
    if (button === APPROVE) return { ok: true, via: "dialog" }
    if (button !== undefined) return { ok: false, reason: "not confirmed" }
  }
  const typed = deps.tty(message)
  if (typed === undefined) {
    return {
      ok: false,
      reason: "no way to ask a person: no dialog and no controlling terminal (use --no-confirm only if you accept that a model in this session could do the same)",
    }
  }
  return typed.trim().toLowerCase() === "yes" ? { ok: true, via: "tty" } : { ok: false, reason: "not confirmed" }
}

export const realDeps: ConfirmDeps = {
  platform: process.platform,
  dialog(message) {
    const script = `display dialog ${JSON.stringify(message)} buttons {"Cancel", "${APPROVE}"} default button "Cancel" with title "opencode lead" giving up after 120`
    const out = spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout: 130_000 })
    if (out.status !== 0) return out.stderr.includes("User canceled") ? "Cancel" : undefined
    return /button returned:([^,]+)/.exec(out.stdout)?.[1]?.trim()
  },
  tty(message) {
    let fd: number
    try {
      fd = openSync("/dev/tty", "r+")
    } catch {
      return undefined
    }
    try {
      writeSync(fd, `${message}\nType "yes" to confirm: `)
      const buffer = Buffer.alloc(64)
      const read = readSync(fd, buffer, 0, buffer.length, null)
      return buffer.subarray(0, read).toString("utf8")
    } catch {
      return undefined
    } finally {
      closeSync(fd)
    }
  },
}

export * as PeerLeadConfirm from "./lead-confirm"
