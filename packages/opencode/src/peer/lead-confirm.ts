// A human-presence check for `lead set`.
//
// Ancestry identifies WHICH session is being designated, but a shell command a
// model runs inside that session has the same ancestry as one the user typed, so
// the command alone cannot prove a person asked for it. Something the model's
// shell cannot answer has to stand between the command and the file.
//
//   1. A native dialog: osascript on macOS, PowerShell on Windows, zenity or kdialog
//      on Linux when a display exists. Strength differs and is not pretended away:
//      macOS needs accessibility rights to click it from a shell, which nobody
//      granted; X11 (xdotool) and Windows (UI Automation) can be driven by a
//      determined shell with no extra rights; Wayland sits between. So the dialog
//      defeats the ordinary case everywhere and a determined adversary on two of
//      the three — the same-user local threat model this feature already states.
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

/** `unavailable` = no dialog could be shown here, so the next channel is tried; `decline` is a refusal and ends it. */
export type DialogAnswer = "approve" | "decline" | "unavailable"

export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
  /** Set when the program could not be started at all (not installed). */
  missing: boolean
}
export type Runner = (command: string, args: string[], env?: Record<string, string>) => RunResult

export interface ConfirmDeps {
  platform: NodeJS.Platform
  /** Shows the dialog; see DialogAnswer. */
  dialog: (message: string) => DialogAnswer
  /** Asks on the controlling terminal; undefined when there is none. */
  tty: (message: string) => string | undefined
}

const APPROVE = "Make lead"
const TITLE = "opencode lead"

export function confirmLead(message: string, deps: ConfirmDeps): ConfirmResult {
  const answer = deps.dialog(message)
  if (answer === "approve") return { ok: true, via: "dialog" }
  if (answer === "decline") return { ok: false, reason: "not confirmed" }
  const typed = deps.tty(message)
  if (typed === undefined) {
    return {
      ok: false,
      reason:
        "no way to ask a person: no dialog could be shown and there is no controlling terminal (use --no-confirm only if you accept that a model in this session could do the same)",
    }
  }
  return typed.trim().toLowerCase() === "yes" ? { ok: true, via: "tty" } : { ok: false, reason: "not confirmed" }
}

/**
 * The dialog for this platform. Untrusted text (a session name) is passed as an
 * argument or an environment variable, never spliced into a script, except for
 * AppleScript, which has no argument channel and gets a JSON-quoted literal
 * (`\"` and `\\` are valid AppleScript escapes; the text is printable ASCII).
 */
export function showDialog(
  message: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  run: Runner,
): DialogAnswer {
  if (platform === "darwin") {
    const script = `display dialog ${JSON.stringify(message)} buttons {"Cancel", "${APPROVE}"} default button "Cancel" with title "${TITLE}" giving up after 120`
    const out = run("osascript", ["-e", script])
    if (out.missing) return "unavailable"
    if (out.status !== 0) return out.stderr.includes("User canceled") ? "decline" : "unavailable"
    const button = /button returned:([^,]+)/.exec(out.stdout)?.[1]?.trim()
    return button === APPROVE ? "approve" : "decline"
  }

  if (platform === "win32") {
    // No Add-Type pipeline games: one MessageBox, default button No, text from env.
    const script =
      "Add-Type -AssemblyName PresentationFramework; " +
      "$r = [System.Windows.MessageBox]::Show($env:OC_LEAD_MSG, $env:OC_LEAD_TITLE, 'YesNo', 'Warning', 'No'); " +
      "Write-Output $r"
    const out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      OC_LEAD_MSG: message,
      OC_LEAD_TITLE: TITLE,
    })
    if (out.missing || out.status !== 0) return "unavailable"
    return out.stdout.trim() === "Yes" ? "approve" : "decline"
  }

  // Linux and the rest: only with a display; otherwise there is nobody to show it to.
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return "unavailable"
  const zenity = run("zenity", ["--question", "--title", TITLE, "--text", message, "--ok-label", APPROVE, "--cancel-label", "Cancel", "--timeout", "120"])
  if (!zenity.missing) {
    if (zenity.status === 0) return "approve"
    // 1 = Cancel/closed, 5 = timeout; anything else is a broken zenity, so try the next.
    if (zenity.status === 1 || zenity.status === 5) return "decline"
  }
  const kdialog = run("kdialog", ["--title", TITLE, "--yesno", message, "--yes-label", APPROVE, "--no-label", "Cancel"])
  if (!kdialog.missing) {
    if (kdialog.status === 0) return "approve"
    if (kdialog.status === 1) return "decline"
  }
  return "unavailable"
}

export const realRunner: Runner = (command, args, env) => {
  const out = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 130_000,
    env: { ...process.env, ...(env ?? {}) },
    windowsHide: false,
  })
  return {
    status: out.status,
    stdout: out.stdout ?? "",
    stderr: out.stderr ?? "",
    missing: (out.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
  }
}

export const realDeps: ConfirmDeps = {
  platform: process.platform,
  dialog: (message) => showDialog(message, process.platform, process.env, realRunner),
  tty(message) {
    // Windows has no /dev/tty; CON is the console device and fails cleanly when there is none.
    const device = process.platform === "win32" ? "CON" : "/dev/tty"
    let fd: number
    try {
      fd = openSync(device, "r+")
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
