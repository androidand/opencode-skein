// Delegating a task to a live peer agent over A2A, and correlating its reply.
//
// A `task` that cannot be placed on a local host (no free slot) may instead be
// handed to an idle peer — a Claude Code session or an opencode session that
// runs on capacity the caller's saturated host does not share. The peer runs
// it as a normal prompt in its own session and answers by messaging the
// delegating session back with a marker line; the reply is intercepted at the
// two inbound entry points (Claude sidecar, `send_peer_message`) and settled
// here instead of being injected as a prompt.
//
// Pure formatting/parsing plus an in-memory registry; no transport.

export const TASK_RESULT_MARKER = "[peer-task-result"

const REPLY_RE = /^\s*\[peer-task-result\s+([A-Za-z0-9_-]+)\]\s*\n?([\s\S]*)$/

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
    `When done, reply with ${input.replyTool} to "${input.replyTo}" and start the message with the exact line:`,
    `${TASK_RESULT_MARKER} ${input.taskID}]`,
    `followed by your result. Reply within ${minutes} min or the task is reassigned. Normal tool permissions apply.`,
    "",
    input.prompt,
  ].join("\n")
}

export function parseTaskReply(text: string): { taskID: string; text: string } | undefined {
  const match = text.match(REPLY_RE)
  if (!match) return undefined
  return { taskID: match[1], text: match[2].trim() }
}

type Settle = (result: TaskReplyResult) => void
export type TaskReplyResult = { ok: true; text: string } | { ok: false; reason: "timeout" | "cancelled" }

const pending = new Map<string, { settle: Settle; timer: ReturnType<typeof setTimeout> }>()

export function awaitTaskReply(taskID: string, timeoutMs: number): Promise<TaskReplyResult> {
  return new Promise((resolve) => {
    const settle: Settle = (result) => {
      const entry = pending.get(taskID)
      if (!entry) return
      clearTimeout(entry.timer)
      pending.delete(taskID)
      resolve(result)
    }
    const timer = setTimeout(() => settle({ ok: false, reason: "timeout" }), timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()
    pending.set(taskID, { settle, timer })
  })
}

/** True when the text was a reply to a task still being waited on. */
export function settleTaskReply(text: string): boolean {
  const reply = parseTaskReply(text)
  if (!reply) return false
  const entry = pending.get(reply.taskID)
  if (!entry) return false
  entry.settle({ ok: true, text: reply.text })
  return true
}

export function cancelTaskReply(taskID: string): void {
  pending.get(taskID)?.settle({ ok: false, reason: "cancelled" })
}

export function pendingTaskIDs(): string[] {
  return [...pending.keys()]
}

export * as PeerDelegate from "./delegate"
