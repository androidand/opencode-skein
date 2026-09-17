import { Schema } from "effect"
import { Loop } from "@/loop/loop"
import { Status, statusFrom } from "./presence-status"

// Re-exported so the presence record reads as one thing; the derivation itself
// lives in a leaf module to keep session/peers.ts out of an import cycle.
export { Status, statusFrom }

export const Owner = Schema.Literals(["opencode-skein", "claude-code"])

export const Info = Schema.Struct({
  owner: Owner,
  instanceID: Schema.String,
  // A metadata projection, not the canonical session identity — a
  // `claude-code` record's sessionID is a foreign UUID and must never be
  // coerced into opencode's `ses_`-shaped branded SessionID.
  sessionID: Schema.String,
  loopID: Schema.optional(Loop.LoopID),
  directory: Schema.String,
  agent: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  status: Status,
  loopStatus: Schema.optional(Loop.Status),
  loopIteration: Schema.optional(Schema.Int),
  lastEventAt: Schema.Finite,
  heartbeatAt: Schema.Finite,
  canPrompt: Schema.Boolean,
  canBtw: Schema.Boolean,
  canAbort: Schema.Boolean,
}).annotate({ identifier: "AgentPresence" })
export type Info = Schema.Schema.Type<typeof Info>

export function isActive(info: Info): boolean {
  return info.status !== "idle" || info.loopStatus === "paused"
}
