// The crew board: a derived view of the openspec backlog coloured by claim
// state. Nothing is stored here — every iteration recomputes from disk and the
// live claim rows, so a restart, a member joining, or a human editing tasks.md
// is reflected without caching.
//
// See design.md for the full shape. What follows is the lean version that the
// brief consumes: one section per class of work, each rendered as plain text
// the model can act on.
import fs from "fs"
import path from "path"

import { parseTasksMd, type TaskItem } from "../spec-queue/tasks-md"
import { readChangeFile } from "../spec-queue/branch-read"
import {
  resolveQueue,
  type QueueChange,
} from "../spec-queue/queue"
import {
  type ClaimInfo,
  DefaultStaleAfterMs,
} from "./claims"

/** A single section of the board. */
export interface BoardSection {
  /** human-readable label */
  title: string
  /** one line per item; empty means "nothing here" */
  items: string[]
}

/** The full board, in the order the brief renders it. */
export interface Board {
  /** the holder's own implement / review / integrate claim, when present */
  own: BoardSection
  /** live claims held by other members — what to unblock before starting new work */
  live: BoardSection
  /** stale claims a member may resume (same branch + worktree) */
  abandoned: BoardSection
  /** changes with an open PR and no live review claim (empty until PR detection lands) */
  review: BoardSection
  /** changes with an approved PR and no live integrate claim (empty until PR detection lands) */
  integrate: BoardSection
  /** intake-* stubs without a live triage claim */
  triage: BoardSection
  /** quarantined changes addressed to the human */
  decide: BoardSection
  /** eligible changes not held by any member — the default cursor target */
  unclaimed: BoardSection
}

function ownClaim(input: BoardInput): BoardSection {
  const { claims, sessionID } = input
  const mine = claims.live.find((c) => c.holderSession === sessionID)
  if (!mine) return { title: "My claim", items: ["(none — pick one below)"] }
  const age = formatAge(Date.now() - mine.since)
  return {
    title: "My claim",
    items: [
      `holding ${mine.slug} (${mine.kind}) · gate: ${mine.gate ?? "?"} · age: ${age}`,
      mine.branch ? `branch: ${mine.branch}` : undefined,
      mine.worktree ? `worktree: ${mine.worktree}` : undefined,
      mine.providerID ? `provider: ${mine.providerID}` : undefined,
    ].filter((x): x is string => x !== undefined),
  }
}

function liveClaims(input: BoardInput): BoardSection {
  const { claims, sessionID } = input
  const others = claims.live.filter((c) => c.holderSession !== sessionID)
  if (others.length === 0) return { title: "Live claims", items: ["(quiet)"] }
  return {
    title: "Live claims",
    items: others.map((c) => {
      const age = formatAge(Date.now() - c.since)
      const parts = [`${c.slug} (${c.kind}) · ${c.holderName ?? c.holderSession ?? "?"} · age: ${age}`]
      if (c.gate) parts.push(`gate: ${c.gate}`)
      return parts.join(" · ")
    }),
  }
}

function abandonedClaims(input: BoardInput): BoardSection {
  const { claims, sessionID } = input
  const others = claims.abandoned.filter((c) => c.holderSession !== sessionID)
  if (others.length === 0) return { title: "Abandoned", items: ["(none)"] }
  return {
    title: "Abandoned",
    items: others.map((c) => {
      const age = formatAge(Date.now() - c.since)
      return `${c.slug} · held by ${c.holderName ?? c.holderSession ?? "?"} · age: ${age}`
    }),
  }
}

function reviewItems(input: BoardInput): BoardSection {
  // PR detection is not wired in yet; this section stays empty until it is.
  return { title: "Review", items: ["(none — PR detection not yet active)"] }
}

function integrateItems(input: BoardInput): BoardSection {
  // PR detection is not wired in yet; this section stays empty until it is.
  return { title: "Integrate", items: ["(none — PR detection not yet active)"] }
}

function triageItems(input: BoardInput): BoardSection {
  const { root, claims } = input
  const liveTriageSlugs = new Set(claims.live.filter((c) => c.kind === "triage").map((c) => c.slug))
  const allChanges = resolveQueue(root)
  const intake = allChanges.eligible.filter((c) => c.slug.startsWith("intake-") && !liveTriageSlugs.has(c.slug))
  if (intake.length === 0) return { title: "Triage", items: ["(none)"] }
  return {
    title: "Triage",
    items: intake.slice(0, 5).map((c) => c.slug),
  }
}

function decideItems(input: BoardInput): BoardSection {
  const { root } = input
  const queue = resolveQueue(root)
  if (queue.quarantined.length === 0) return { title: "Decide", items: ["(none — the crew is clear)"] }
  return {
    title: "Decide",
    items: queue.quarantined.map((slug) => `⚠ ${slug} needs a human call`),
  }
}

function unclaimedItems(input: BoardInput): BoardSection {
  const { root, claims } = input
  const claimedSlugs = new Set(claims.live.map((c) => c.slug))
  const queue = resolveQueue(root, undefined, claimedSlugs)
  if (queue.eligible.length === 0) return { title: "Unclaimed", items: ["(backlog empty)"] }
  return {
    title: "Unclaimed",
    items: queue.eligible.slice(0, 5).map((c) => `${c.slug} — ${firstTask(c.tasks)}`),
  }
}

/** Picks the first unchecked task text so the model can scan the backlog quickly. */
function firstTask(tasks: TaskItem[]): string {
  const unchecked = tasks.find((t) => !t.checked)
  return unchecked ? (unchecked.id ? `${unchecked.id} ` : "") + unchecked.text : "(no tasks)"
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3600_000)}h`
}

export interface BoardInput {
  /** repo root — used to resolve the openspec queue from disk */
  root: string
  /** live claims in this project */
  claims: { live: ClaimInfo[]; abandoned: ClaimInfo[] }
  /** the session that owns the brief — its claims are labelled "own" */
  sessionID: string
}

/**
 * Derives the crew board from the openspec tree and the current claim state.
 *
 * The queue is re-resolved from disk every call so mid-run edits and restarts
 * are visible. No caching is involved.
 */
export function deriveBoard(input: BoardInput): Board {
  return {
    own: ownClaim(input),
    live: liveClaims(input),
    abandoned: abandonedClaims(input),
    review: reviewItems(input),
    integrate: integrateItems(input),
    triage: triageItems(input),
    decide: decideItems(input),
    unclaimed: unclaimedItems(input),
  }
}

/** Renders the board as plain text suitable for inclusion in a loop brief. */
export function renderBoard(board: Board): string {
  const parts: string[] = []
  for (const section of [
    board.own,
    board.live,
    board.abandoned,
    board.review,
    board.integrate,
    board.triage,
    board.decide,
    board.unclaimed,
  ]) {
    parts.push(`## ${section.title}`)
    parts.push(section.items.join("\n"))
    parts.push("")
  }
  return parts.join("\n")
}

export * as Board from "./board"
