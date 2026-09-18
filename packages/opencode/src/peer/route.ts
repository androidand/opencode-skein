// Where an opencode session lives decides how a message reaches it.
//
// Every opencode process has its own in-memory bus, status map and prompt
// lock; only the SQLite store is shared. Prompting a session another process
// is driving from here would run its turn in the wrong process — the owning
// TUI never sees it and two processes race on one session. So a session this
// process does not own is reached the same way a Claude Code peer is: over
// the UDS socket of the sidecar its owner registered (`ownerSessionID` in the
// registry), which hands the text to the owner process's `deliver`.

import { Effect } from "effect"
import { sendClaudeMessage, type SendClaudeMessageResult } from "./claude/client"
import { isManaged } from "./claude/sidecar-manager"
import { listManagedRegistrations, type SidecarRegistration } from "./claude/sidecar-registry"

export const OPENCODE_FROM_PREFIX = "uds:opencode-skein:"

export type ForeignStatus = "idle" | "busy"

export interface ForeignPeer {
  sessionID: string
  title: string
  directory: string
  status: ForeignStatus
  pid: number
}

export interface ForeignRoster {
  /** ownerSessionID → status, for `ResolveInput.foreign`. */
  statuses: Map<string, ForeignStatus>
  peers: ForeignPeer[]
  /**
   * `Session.list()` is scoped to this process's project; a sibling in
   * another directory is only known through its registration. Add those as
   * sessions so they resolve as targets and show in the roster.
   */
  merge: <T extends { id: string; directory: string; title: string; updatedAt: number; parentID?: string }>(
    sessions: readonly T[],
  ) => T[]
}

/** Registry truth for sessions owned by OTHER opencode processes. */
export async function foreignRoster(): Promise<ForeignRoster> {
  const peers: ForeignPeer[] = []
  const statuses = new Map<string, ForeignStatus>()
  for (const entry of await safeRegistrations()) {
    if (isManaged(entry.ownerSessionID)) continue
    const status: ForeignStatus = entry.status === "busy" ? "busy" : "idle"
    statuses.set(entry.ownerSessionID, status)
    peers.push({
      sessionID: entry.ownerSessionID,
      title: entry.name.replace(/^opencode:/, ""),
      directory: entry.cwd,
      status,
      pid: entry.pid,
    })
  }
  const now = Date.now()
  return {
    statuses,
    peers,
    merge: (sessions) => {
      const known = new Set(sessions.map((s) => s.id))
      const extra = peers
        .filter((peer) => !known.has(peer.sessionID))
        .map((peer) => ({ id: peer.sessionID, directory: peer.directory, title: peer.title, updatedAt: now }))
      return [...sessions, ...(extra as unknown as typeof sessions)]
    },
  }
}

export async function foreignStatuses(): Promise<Map<string, ForeignStatus>> {
  return (await foreignRoster()).statuses
}

export async function foreignRegistration(sessionID: string): Promise<SidecarRegistration | undefined> {
  if (isManaged(sessionID)) return undefined
  return (await safeRegistrations()).find((entry) => entry.ownerSessionID === sessionID)
}

async function safeRegistrations(): Promise<SidecarRegistration[]> {
  try {
    return await listManagedRegistrations()
  } catch {
    return []
  }
}

export type DeliverOutcome =
  | { via: "local" }
  | { via: "socket"; result: SendClaudeMessageResult }

/**
 * Deliver `text` to an opencode session: in-process when this process owns
 * it (or nothing else has registered it), over its owner's sidecar socket
 * otherwise. `local` is the caller's own prompt injection.
 */
export function deliverToOpencodeSession<E, R>(input: {
  targetSessionID: string
  fromSessionID: string
  fromName: string
  text: string
  local: () => Effect.Effect<void, E, R>
}): Effect.Effect<DeliverOutcome, E, R> {
  return Effect.gen(function* () {
    const entry = yield* Effect.promise(() => foreignRegistration(input.targetSessionID))
    if (!entry) {
      yield* input.local()
      return { via: "local" as const }
    }
    const result = yield* Effect.promise(() =>
      sendClaudeMessage({
        targetPid: entry.pid,
        fromSessionID: input.fromSessionID,
        fromName: input.fromName,
        fromMode: "prompting",
        text: input.text,
      }),
    )
    return { via: "socket" as const, result }
  })
}

/** Sender session id when an inbound envelope came from an opencode peer, else undefined. */
export function opencodeSenderOf(from: string | undefined): string | undefined {
  if (!from?.startsWith(OPENCODE_FROM_PREFIX)) return undefined
  const id = from.slice(OPENCODE_FROM_PREFIX.length)
  return id.length > 0 ? id : undefined
}

export * as PeerRoute from "./route"
