// Per-iteration brief for a queue loop: the change's own documents plus the
// next unchecked task, and — when the fleet has idle capacity — a fan-out
// nudge (design D9: awareness only; placement machinery does the rest).
import fs from "fs"
import path from "path"

import { uncheckedTasks } from "./tasks-md"
import { readChangeFile } from "./branch-read"
import type { QueueChange } from "./queue"
import type { InboxEntry } from "../loop"

export type Gate = "implement" | "test" | "verify" | "commit"

/** A local inference host, as `LocalPlacement.hostCapacity` reports it. */
export interface FleetHost {
  providerID: string
  reachable: boolean
  /** Concurrent requests the host accepts; local llama.cpp hosts are usually 1. */
  slotsTotal?: number
  free: number
  reserved: number
  loadedModel?: string
}

/** A peer session that is bound to a host (or cloud-backed, no host). */
export interface FleetPeer {
  sessionID: string
  title: string
  status: string
  provider?: string
  model?: string
}

/** The fleet join: which sessions hold which hosts, for the routing order. */
export interface FleetJoin {
  hosts: FleetHost[]
  peers: FleetPeer[]
}

export interface BriefInput {
  /** repo root, used to resolve the change's branch via `git show` */
  root: string
  change: QueueChange
  gate: Gate
  /** failure output from the previous gate evaluation, when returning to implement */
  failure?: { gate: Gate; output: string }
  /** names of idle local peer providers; empty → no fan-out nudge */
  idlePeers: readonly string[]
  /**
   * Other sessions working in this directory right now, already described.
   * Empty means the repo is quiet — the paragraph is then omitted entirely,
   * because a collision warning that fires constantly stops being read.
   */
  peers?: readonly string[]
  /**
   * Agent bound to this gate, when one resolved. The nudge names it instead of
   * gesturing at "the task tool" — an instruction naming nobody is one the
   * model can ignore at no cost, which is exactly what happened. Absent means
   * the repo has no such persona, and no fan-out instruction is emitted at all:
   * telling a model to delegate to an agent that does not exist is worse than
   * telling it nothing.
   */
  persona?: string
  /**
   * Corrections given while the run was already going (`/nudge`), in the order
   * given. They outrank `guidance`: guidance is what the run started with,
   * these arrived because it was going the wrong way.
   */
  steers?: readonly string[]
  /**
   * Optional standing instruction from the operator, repeated on every
   * iteration of the run. Steers HOW the work is done ("prefer small commits",
   * "leave the CLI alone"); it never decides WHAT is worked, because that is
   * derived from the checkboxes on disk and must stay that way.
   */
  guidance?: string
  /**
   * Set when the previous turn ended by asking the user or waiting on a peer
   * (loop/stop-reason.ts): tells the model to decide and continue instead of stopping again.
   */
  stopNudge?: string
  /**
   * Inbound peer messages delivered while the loop was running, drained from
   * the inbox at the top of this iteration. Empty when no messages arrived.
   */
  inbox?: readonly InboxEntry[]
  /**
   * Fleet join: which sessions hold which hosts. When present the brief
   * states the routing order explicitly and inlines the join so a member
   * sees who holds what. Absent means no fleet data is available and the
   * brief falls back to the simple idle-peer nudge.
   */
   fleet?: FleetJoin
   /** True when this is a crew-mode run; the brief includes the crew charter. */
   crewMode?: boolean
}

// A change's documents are inlined because each iteration runs in a fresh child
// session. They are not unbounded: a change that has been re-dispatched for a
// long time accretes notes into tasks.md (one reached 3,000+ lines, ~220 KB),
// and a brief bigger than the model's window is rejected before the model sees
// it. Past these caps the agent gets a head or a digest plus the path to read.
const MaxDocChars = 12_000
const MaxSpecChars = 8_000
const MaxNextTaskChars = 6_000
const MaxLineChars = 160

const CHECKBOX_LINE = /^\s*-\s*\[([ xX])\]/
const HEADING_LINE = /^#{1,6}\s/

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** Head of `text` within `max`, with a pointer to the full file when cut. */
function capDoc(text: string, max: number, relPath: string): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[… ${text.length - max} more characters omitted — read the full file at ${relPath}]`
}

/**
 * A tasks.md past the cap, reduced to what the next step needs: every heading
 * and checklist line (the whole picture, one line each) plus the full block of
 * the first open task, where its notes and blockers live. A plain head cut would
 * show the oldest, already-checked notes and bury the open task.
 */
function digestTasks(content: string, relPath: string): string {
  const entries: { text: string; checked: boolean }[] = []
  const next: string[] = []
  let capturing = false
  let found = false
  for (const line of content.split("\n")) {
    const checkbox = line.match(CHECKBOX_LINE)
    if (checkbox) {
      capturing = false
      entries.push({ text: clip(line, MaxLineChars), checked: checkbox[1] !== " " })
      if (!found && checkbox[1] === " ") {
        found = true
        capturing = true
        next.push(line)
      }
      continue
    }
    if (HEADING_LINE.test(line)) {
      capturing = false
      entries.push({ text: clip(line, MaxLineChars), checked: false })
      continue
    }
    if (capturing) next.push(line)
  }
  // Even one line per task can outgrow the cap; checked tasks go first, since
  // the open ones and the headings are what the next step is chosen from.
  let lines = entries.map((entry) => entry.text)
  if (lines.join("\n").length > MaxDocChars) {
    const kept = entries.filter((entry) => !entry.checked)
    lines = [`(${entries.length - kept.length} checked tasks omitted)`, ...kept.map((entry) => entry.text)]
  }
  return [
    `[tasks.md is ${content.length} characters; showing its checklist and the first open task in full — read ${relPath} for the rest]`,
    "",
    ...lines,
    ...(next.length > 0 ? ["", "### First open task, in full", "", capDoc(next.join("\n"), MaxNextTaskChars, relPath)] : []),
  ].join("\n")
}

function readIfExists(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined
  return fs.readFileSync(file, "utf8")
}

function specFiles(changeDir: string): string[] {
  const specsDir = path.join(changeDir, "specs")
  if (!fs.existsSync(specsDir)) return []
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === "spec.md") out.push(full)
    }
  }
  walk(specsDir)
  return out.sort()
}

/** Renders the routing order and fleet join as brief text. */
function describeFleetJoin(fleet: FleetJoin, persona?: string): string {
  const lines: string[] = []

  // Routing order: the explicit priority a crew member should follow.
  lines.push(
    [
      "Crew routing order — route work in this priority:",
      "1. Ask an idle colleague already on a host with the needed model (warm — costs the fleet nothing).",
      "2. Ask a cloud-backed colleague (costs the fleet nothing).",
      "3. Spawn a subagent on a free host.",
      "4. If nothing is free, leave the item on the board — do not spawn into a queue.",
    ].join("\n"),
  )

  // Fleet join: which hosts are held by whom.
  if (fleet.hosts.length > 0) {
    lines.push("Fleet join:")
    for (const host of fleet.hosts) {
      if (!host.reachable) {
        lines.push(`- ${host.providerID}: unreachable`)
        continue
      }
      const slots =
        host.slotsTotal !== undefined
          ? `${host.free}/${host.slotsTotal} slot${host.slotsTotal === 1 ? "" : "s"} free`
          : host.free > 0
            ? "idle"
            : "busy"
      const held = host.reserved > 0 ? `, ${host.reserved} reserved by this instance` : ""
      const loaded = host.loadedModel ? `, ${host.loadedModel} loaded` : ", no model loaded"
      const on = fleet.peers.filter((p) => p.provider === host.providerID)
      const who = on.length === 0 ? "" : ` — bound here: ${on.map((p) => `${p.sessionID} ("${p.title}")`).join(", ")}`
      lines.push(`- ${host.providerID}: ${slots}${held}${loaded}${who}`)
    }

    const warm = fleet.peers.filter((p) => p.provider !== undefined).length
    const freeHosts = fleet.hosts.filter((h) => h.reachable && h.free > 0).length
    const note =
      warm > 0 && freeHosts === 0
        ? "Every reachable host is occupied. A new subagent would queue behind one of these; a message to the session already on that host costs nothing extra."
        : warm > 0
          ? "A session already on a host has its model loaded and its cache warm — giving it work is cheaper than spawning a subagent, which takes a slot and may force a model load."
          : "No session is holding a host right now."
    lines.push(note)
  }

  // Legacy idle-peer nudge, when persona is set.
  if (fleet.hosts.length === 0 && persona) {
    lines.push(
      [
        `Fleet capacity: ${fleet.peers.length} idle local provider${fleet.peers.length === 1 ? "" : "s"}`,
        `(${fleet.peers.map((p) => p.provider ?? "?").join(", ")}) can take delegated work right now. Where this change's`,
        `tasks are independent of each other, delegate them with the task tool using`,
        `subagent_type "${persona}" — one call per independent slice, and placement will`,
        "put them on idle peers automatically. Keep work that shares a file in one call.",
      ].join(" "),
    )
  }

  return lines.join("\n")
}

const GATE_INSTRUCTIONS: Record<Gate, string> = {
  implement: [
    "You are in the IMPLEMENT gate. Work the next unchecked task to completion,",
    "check it off in tasks.md with a short note of what you verified, and keep the",
    "change's own Validation commands passing as you go. Do not push, tag, publish,",
    "or deploy anything.",
  ].join(" "),
  test: [
    "You are in the TEST gate. Run the repository test suite relevant to this change",
    "and fix failures your change caused. Do not weaken or delete tests to make them pass.",
  ].join(" "),
  verify: [
    "You are in the VERIFY gate. Run the typecheck and each task's stated Validation",
    "command; fix what fails. Do not check off tasks that do not pass their validation.",
  ].join(" "),
  commit: [
    "You are in the COMMIT gate. Commit the change's work to a non-default branch",
    "named loop/<change-slug>. Never commit to the default branch and never push.",
  ].join(" "),
}

/** The crew charter: stated at the top of every crew-mode brief. */
const CREW_CHARTER = [
  "## Crew charter",
  "",
  "You are one member of a crew working this repository's openspec backlog.",
  "You are holding one of a small number of inference hosts; your colleagues",
  "are holding the others. Work you hand to a colleague who is already warm",
  "costs the fleet nothing. Work you spawn as a subagent takes a host, and when",
  "none is free it simply queues, so prefer asking a colleague, and when",
  "nothing is free leave the item on the board instead of spawning into it.",
  "Unblock others before starting new work: a review someone is waiting on",
  "beats a fresh change. Claim before you touch a change; work only in the",
  "worktree your claim names. Announce a claim, a handoff, and a blocker to",
  "the crew with a short notify; ask a bounded question with a request and",
  "keep working while you wait. Never take on work a peer says it was denied.",
  "If the board is empty, say so and stop this iteration; the loop will check",
  "again. Do not create changes; propose them as intake and let the human",
  "clear them.",
].join("\n")

/** Composes the brief text sent as the iteration's prompt. */
export function buildBrief(input: BriefInput): string {
  const { change } = input
  const parts: string[] = []

  // Crew charter comes first in crew mode so it sets the priority order
  // before any change-specific content.
  if (input.crewMode) {
    parts.push(CREW_CHARTER)
  }

  parts.push(
    [
      `You are working the openspec change "${change.slug}" as part of an unattended queue run.`,
      `The change lives at ${change.directory}.`,
      GATE_INSTRUCTIONS[input.gate],
    ].join("\n"),
  )

  if (input.stopNudge) parts.push(input.stopNudge)

  if (input.failure) {
    parts.push(
      [
        `The previous ${input.failure.gate.toUpperCase()} gate failed. Fix the cause before anything else.`,
        "Failure output:",
        "```",
        input.failure.output.trim().slice(0, 8_000),
        "```",
      ].join("\n"),
    )
  }

  // Placed before the change documents so a long proposal cannot bury it, and
  // repeated every iteration because each one runs in a fresh child session
  // with no memory of the last.
  if (input.guidance?.trim()) {
    parts.push(`Standing instruction from the operator, applies to every iteration:\n${input.guidance.trim()}`)
  }

  // After the standing instruction, because these are corrections TO it: the
  // operator said them after watching the run go wrong, so where the two
  // conflict these win.
  if (input.steers && input.steers.length > 0) {
    parts.push(
      [
        "Corrections from the operator, given while this run was already going.",
        "They override the standing instruction above wherever the two disagree:",
        "",
        ...input.steers.map((steer) => `- ${steer}`),
      ].join("\n"),
    )
  }

  if (input.inbox && input.inbox.length > 0) {
    const lines = input.inbox.map((entry) => {
      const from = entry.from.name ?? entry.from.id
      return `[${entry.mode}] from ${from}: ${entry.text}`
    })
    parts.push(["Inbound peer messages since last iteration:", "", ...lines].join("\n"))
  }

  const next = uncheckedTasks(change.tasks)[0]
  if (next) {
    parts.push(`Next unchecked task: ${next.id ? `${next.id} ` : ""}${next.text}`)
  }

  const proposalPath = `openspec/changes/${change.slug}/proposal.md`
  const proposal = readChangeFile(input.root, change.slug, proposalPath)
  if (proposal) parts.push(`## proposal.md\n\n${capDoc(proposal, MaxDocChars, proposalPath)}`)

  const tasksPath = `openspec/changes/${change.slug}/tasks.md`
  const tasks = readChangeFile(input.root, change.slug, tasksPath)
  if (tasks) parts.push(`## tasks.md\n\n${tasks.length > MaxDocChars ? digestTasks(tasks, tasksPath) : tasks}`)

  for (const file of specFiles(change.directory)) {
    const rel = path.relative(change.directory, file)
    parts.push(`## ${rel}\n\n${capDoc(fs.readFileSync(file, "utf8"), MaxSpecChars, `openspec/changes/${change.slug}/${rel}`)}`)
  }

  if (input.peers && input.peers.length > 0) {
    parts.push(
      [
        `Another agent is working in this repository right now — you are not alone in this checkout.`,
        "Two agents editing one working tree is a real failure here, not a hypothetical:",
        "",
        ...input.peers.map((peer) => `- ${peer}`),
        "",
        "Before you touch shared state — a branch, the git index, a migration, a manifest —",
        "consider whether that session is already doing it. If its title overlaps this change,",
        "say so in your reply rather than racing it. You cannot read its messages.",
      ].join("\n"),
    )
  }

  if (input.fleet) {
    parts.push(describeFleetJoin(input.fleet, input.persona))
  } else if (input.idlePeers.length > 0 && input.persona) {
    parts.push(
      [
        `Fleet capacity: ${input.idlePeers.length} idle local provider${input.idlePeers.length === 1 ? "" : "s"}`,
        `(${input.idlePeers.join(", ")}) can take delegated work right now. Where this change's`,
        `tasks are independent of each other, delegate them with the task tool using`,
        `subagent_type "${input.persona}" — one call per independent slice, and placement will`,
        "put them on idle peers automatically. Keep work that shares a file in one call.",
      ].join(" "),
    )
  }

  return parts.join("\n\n")
}

export * as SpecQueueBrief from "./brief"
