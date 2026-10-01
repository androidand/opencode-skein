// Runtime glue between the pure grant check (./lead) and the delivery paths.
// Kept apart from ./lead so that module stays free of global paths and can be
// tested without them.
import { join } from "path"
import { Global } from "@opencode-ai/core/global"
import { readGrantFile, verifyLead, type Sender, type Verdict } from "./lead"

/** Where the user's grant lives. One per machine; written only by a user action. */
export function grantPath(): string {
  return join(Global.Path.state, "crew", "lead.json")
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists and belongs to someone else — alive.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * The verdict for one inbound sender. Reads the file every time: grants are
 * short-lived and revocable, so a cached "yes" would outlive `/lead off`.
 * Any failure to read or validate is "not granted" — the default frame.
 */
export function leadVerdictFor(sender: Sender, follow: boolean, now = Date.now(), path = grantPath()): Verdict {
  if (!follow) return { granted: false, reason: "this session does not follow a lead" }
  const result = readGrantFile(path, { now, pidAlive, uid: process.getuid?.() ?? -1 })
  if (!result.ok) return { granted: false, reason: result.reason }
  return verifyLead(result.grant, sender, { follow, now })
}

export * as PeerLeadRuntime from "./lead-runtime"
