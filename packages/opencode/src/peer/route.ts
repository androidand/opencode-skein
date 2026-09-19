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
import { isManaged, sidecarSocketPathFor } from "./claude/sidecar-manager"
import { listManagedRegistrations, type SidecarRegistration } from "./claude/sidecar-registry"

/**
 * The return address used when the sending session has no sidecar. It is
 * deliberately not connectable — nothing listens there — so a peer that
 * follows the protocol's reply rule ("send to `from`") gets a clear failure
 * rather than silence. Whenever a sidecar exists, `returnAddressFor` gives a
 * real socket instead and this prefix never goes on the wire.
 */
export const OPENCODE_FROM_PREFIX = "uds:opencode-skein:"

const UDS_PREFIX = "uds:"

/**
 * The `from` a peer should reply to. Claude Code's own reply rule is to copy
 * an inbound message's `from` attribute as the `to` of the reply, so this
 * has to be the sender's real sidecar socket whenever one is up; the
 * placeholder prefix is the fallback for a session that has none (a
 * subagent, or messaging disabled), in which case no reply can arrive.
 */
export function returnAddressFor(sessionID: string): { address: string; reachable: boolean } {
  const socketPath = sidecarSocketPathFor(sessionID)
  if (socketPath) return { address: `${UDS_PREFIX}${socketPath}`, reachable: true }
  return { address: `${OPENCODE_FROM_PREFIX}${sessionID}`, reachable: false }
}

/** The pid encoded in a Claude Code peer's socket address (`uds:/tmp/cc-socks/<pid>.sock`), as a `send_peer_message` target. */
export function claudePidOf(from: string | undefined): string | undefined {
  const match = from?.match(/(\d+)\.sock$/)
  return match?.[1]
}

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

/**
 * Sessions an opencode process is actually attending right now, whichever
 * process that is.
 *
 * "Idle" on its own conflates two different things: a session that finished
 * its turn and is waiting for input, and a session row whose process exited
 * days ago. Both look identical from the store — the only difference is
 * `time.updated`, and a session that went quiet an hour ago may be either.
 * A registration is the honest signal: it exists only while a process is
 * running a sidecar for that session, and its pid is checked here rather
 * than trusted, so a registration left behind by a crash does not read as a
 * session someone is sitting at.
 */
export async function liveSessionIDs(): Promise<Set<string>> {
  const live = new Set<string>()
  for (const entry of await safeRegistrations()) {
    try {
      process.kill(entry.pid, 0)
    } catch {
      continue
    }
    live.add(entry.ownerSessionID)
  }
  return live
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
  /** No registered address, and not a session this process may prompt itself. */
  | { via: "unaddressable" }

/**
 * Deliver `text` to an opencode session: in-process when this process owns
 * it, over its owner's sidecar socket otherwise. `local` is the caller's own
 * prompt injection.
 *
 * `owned` says whether the target belongs to an instance THIS process is
 * driving. It is not optional bookkeeping: prompting a session another
 * process owns runs its turn in the wrong process, so a target with neither
 * a registration nor local ownership has no safe delivery path and is
 * reported as such rather than prompted anyway.
 */
export function deliverToOpencodeSession<E, R>(input: {
  targetSessionID: string
  fromSessionID: string
  fromName: string
  text: string
  owned: boolean
  local: () => Effect.Effect<void, E, R>
}): Effect.Effect<DeliverOutcome, E, R> {
  return Effect.gen(function* () {
    const entry = yield* Effect.promise(() => foreignRegistration(input.targetSessionID))
    if (!entry) {
      if (!input.owned) return { via: "unaddressable" as const }
      yield* input.local()
      return { via: "local" as const }
    }
    const result = yield* Effect.promise(() =>
      sendClaudeMessage({
        targetPid: entry.pid,
        fromSessionID: input.fromSessionID,
        fromAddress: returnAddressFor(input.fromSessionID).address,
        fromName: input.fromName,
        fromMode: "prompting",
        text: input.text,
      }),
    )
    return { via: "socket" as const, result }
  })
}

/** Sender session id when an inbound envelope carries the placeholder opencode address, else undefined. */
export function opencodeSenderOf(from: string | undefined): string | undefined {
  if (!from?.startsWith(OPENCODE_FROM_PREFIX)) return undefined
  const id = from.slice(OPENCODE_FROM_PREFIX.length)
  return id.length > 0 ? id : undefined
}

/**
 * Sender session id when an inbound envelope came from an opencode peer by
 * either address form: the placeholder prefix, or a real sidecar socket that
 * some opencode process registered (looked up by `messagingSocketPath`, the
 * registry's own key for it). Anything else — a real Claude Code socket —
 * is undefined.
 */
export async function resolveOpencodeSender(from: string | undefined): Promise<string | undefined> {
  const direct = opencodeSenderOf(from)
  if (direct) return direct
  if (!from?.startsWith(UDS_PREFIX)) return undefined
  const socketPath = from.slice(UDS_PREFIX.length)
  const entry = (await safeRegistrations()).find((registration) => registration.messagingSocketPath === socketPath)
  return entry?.ownerSessionID
}

export * as PeerRoute from "./route"
