// Target resolution against Claude Code's live roster, mirroring
// `session/peers.ts`'s `resolveTarget` shape: exact id (pid or Claude's own
// session UUID) first, else an unambiguous case-insensitive prefix of the
// session's display name. Never guesses — more than one name match is
// reported ambiguous rather than picking the first.
import { fetchClaudeAgentRecords, type ClaudeAgentRecord } from "@/agent/presence-claude"

export type ResolveClaudeTargetResult =
  | { ok: true; record: ClaudeAgentRecord }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "ambiguous"; matches: ClaudeAgentRecord[] }

export async function resolveClaudeTarget(
  target: string,
  opts: { enabled: boolean },
): Promise<ResolveClaudeTargetResult> {
  const trimmed = target.trim()
  const records = await fetchClaudeAgentRecords({ enabled: opts.enabled })

  const byId = records.find((record) => String(record.pid) === trimmed || record.sessionId === trimmed)
  if (byId) return { ok: true, record: byId }

  const needle = trimmed.toLowerCase()
  const nameMatches = records.filter((record) => record.name?.toLowerCase().startsWith(needle))
  if (nameMatches.length === 1) return { ok: true, record: nameMatches[0] }
  if (nameMatches.length > 1) return { ok: false, reason: "ambiguous", matches: nameMatches }

  // Peers can be in any directory — "portal" or "guard-deletes" means
  // "whoever is working in/on that repo", matching `session/peers.ts`'s
  // resolveTarget for the opencode side.
  const dirMatches = records.filter((record) => record.cwd.toLowerCase().includes(needle))
  if (dirMatches.length === 1) return { ok: true, record: dirMatches[0] }
  if (dirMatches.length === 0) return { ok: false, reason: "not-found" }
  return { ok: false, reason: "ambiguous", matches: dirMatches }
}

export * as ClaudeResolve from "./resolve"
