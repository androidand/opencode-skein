// Delegating a task to a live peer agent over A2A, and correlating its reply.
//
// A `task` that cannot be placed on a local host (no free slot) may instead be
// handed to an idle peer — a Claude Code session or an opencode session that
// runs on capacity the caller's saturated host does not share. The peer runs
// it as a normal prompt in its own session and answers by messaging the
// delegating session back with a structured peer envelope whose header carries
// the task id (`[peer reply task=<id>]`); the reply is intercepted at the two
// inbound entry points (Claude sidecar, `send_peer_message`) and settled here
// instead of being injected as a prompt.
//
// Pure formatting/parsing plus an in-memory registry; no transport.

import { InvalidTransition, PeerDelivery } from "./delivery-state"
import { parsePeerEnvelope } from "./envelope"

export interface PeerCandidate {
  owner: "opencode-skein" | "claude-code"
  /** Claude Code pid, or opencode session id. */
  id: string
  name: string
  status: string
  /** Provider the peer's model runs on, when known (opencode only). */
  provider?: string
  idleForMs?: number
}

/**
 * Peers that can take work right now. Idle only; an opencode peer whose model
 * runs on a local host adds nothing — that host is already a `host`
 * candidate, and prompting the peer would queue on the same slot.
 */
export function pickPeer(input: {
  peers: readonly PeerCandidate[]
  localProviderIDs: ReadonlySet<string>
}): PeerCandidate | undefined {
  const eligible = input.peers.filter((peer) => {
    if (peer.status !== "idle") return false
    if (peer.owner === "opencode-skein" && peer.provider && input.localProviderIDs.has(peer.provider)) return false
    return true
  })
  eligible.sort((a, b) => {
    if (a.owner !== b.owner) return a.owner === "claude-code" ? -1 : 1
    return (a.idleForMs ?? 0) - (b.idleForMs ?? 0)
  })
  return eligible[0]
}

export interface TaskEnvelopeInput {
  taskID: string
  description: string
  prompt: string
  cwd: string
  /** How the peer addresses the delegating session in its own send tool. */
  replyTo: string
  replyTool: string
  deadlineMs: number
}

export function buildTaskEnvelope(input: TaskEnvelopeInput): string {
  const minutes = Math.max(1, Math.round(input.deadlineMs / 60_000))
  return [
    `[peer-task ${input.taskID}] ${input.description}`,
    `Delegated by another agent session because it has no free local capacity. Work in ${input.cwd}.`,
    `When done, reply with ${input.replyTool} to "${input.replyTo}" using a structured peer envelope whose header starts with:`,
    `[peer reply task=${input.taskID}]`,
    `then your result. Reply within ${minutes} min or the task is reassigned. Normal tool permissions apply.`,
    "",
    input.prompt,
  ].join("\n")
}

export function parseTaskReply(text: string): { taskID: string; text: string } | undefined {
  const match = text.match(REPLY_RE)
  if (!match) return undefined
  return { taskID: match[1], text: match[2].trim() }
}

type TaskEntry = {
  settle: (result: TaskReplyResult) => void
  timer: ReturnType<typeof setTimeout>
  delivery: PeerDelivery
}

export type TaskReplyResult = { ok: true; text: string } | { ok: false; reason: "timeout" | "cancelled" }

const pending = new Map<string, TaskEntry>()

/**
 * Register a pending task by its `taskID` and return a `{ promise, delivery }`
 * pair. The promise resolves when a reply carrying a `[peer reply task=<taskID>]`
 * structured envelope arrives.
 * The `delivery` object owns the bounded state machine.
 */
export function awaitTaskReply(taskID: string, timeoutMs: number): {
  promise: Promise<TaskReplyResult>
  delivery: PeerDelivery
} {
  const delivery = new PeerDelivery()
  return {
    promise: new Promise<TaskReplyResult>((resolve) => {
      const settle: TaskEntry["settle"] = (result) => {
        const entry = pending.get(taskID)
        if (!entry) return
        clearTimeout(entry.timer)
        pending.delete(taskID)
        resolve(result)
      }
      const timer = setTimeout(() => {
        const entry = pending.get(taskID)
        if (!entry) return
        clearTimeout(entry.timer)
        pending.delete(taskID)
        try {
          delivery.transition("timed out")
        } catch {
          // A late reply already settled the task; the timeout is superseded.
        }
        resolve({ ok: false, reason: "timeout" })
      }, timeoutMs)
      ;(timer as { unref?: () => void }).unref?.()
      pending.set(taskID, { settle, timer, delivery })
    }),
    delivery,
  }
}

/**
 * True when the text was a reply to a task still being waited on.
 *
 * The task id rides in the reply's structured envelope header (`[peer reply
 * task=<id>]`), so correlation matches the header rather than a marker anchored
 * at the start of the body. That is the point of the migration: a reply whose
 * id is matched out of the header settles whether or not anything else precedes
 * it, and a plain message without the header is left to fall through to prompt
 * injection rather than being mistaken for a task answer.
 *
 * When the task has already terminalised (timed out, failed, or already
 * replied), the reply is recorded as superseded and the state machine refuses
 * the flip — the return value is `false` so the caller treats it as "no
 * pending task was settled" rather than throwing.
 */
export function settleTaskReply(text: string): boolean {
  const parsed = parsePeerEnvelope(text)
  const taskID = parsed?.envelope.mode === "reply" ? parsed.envelope.taskID : undefined
  if (!taskID) return false
  const entry = pending.get(taskID)
  if (!entry) return false
  try {
    entry.delivery.transition("replied")
  } catch {
    // A terminal state refuses the flip; the reply is superseded.
    return false
  }
  entry.settle({ ok: true, text: parsed?.body ?? "" })
  return true
}

export function cancelTaskReply(taskID: string): void {
  const entry = pending.get(taskID)
  if (!entry) return
  try {
    entry.delivery.transition("failed")
  } catch {
    // Already in a terminal state — the cancel is a no-op for state purposes.
  }
  entry.settle({ ok: false, reason: "cancelled" })
}

export function pendingTaskIDs(): string[] {
  return [...pending.keys()]
}

export * as PeerDelegate from "./delegate"
