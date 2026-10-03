// Cross-repository work source for the loop runner.
//
// The runner asks this module for the next item to work. It combines two
// sources:
//
// 1. specsync query: for repositories with a tracker binding, returns
//    claimable changes ordered by the tracker.
// 2. Disk fallback: for repositories without a binding, returns eligible
//    changes from openspec/changes/ (the existing queue logic).
//
// A repository is considered "synced" when it has a .specsync/board.json
// with at least one non-empty binding. Synced repos are queried via
// specsync; unsynced repos fall back to disk.
//
// The runner treats the returned array as an opaque, ordered list. It
// SHALL NOT re-sort it.

import fs from "fs"
import path from "path"
import { Effect } from "effect"

export interface WorkItem {
  /** Absolute path to the repository root. */
  repo: string
  /** Change slug (directory name under openspec/changes/). */
  change: string
  /** First H1 of proposal.md. */
  title: string
  /** Tracker item reference (owner/repo#N) when bound; empty otherwise. */
  item: string
  /** Why this item is claimable (e.g. "stage=active"). */
  reason: string
  /** Priority (1=highest) or null if unset. */
  priority: number | null
  /** Blocker refs (owner/repo#N) or empty. */
  blockedBy: string[]
  /** Absolute path to the change directory. */
  changeDir: string
  /** Absolute path to the openspec directory. */
  openspecDir: string
}

export interface WorkSourceResult {
  /** Items to work, in order. Empty when nothing is claimable. */
  items: WorkItem[]
  /** Repositories that were scanned. */
  scanned: string[]
  /** Errors encountered during scanning (non-fatal). */
  errors: string[]
}

interface QueryItem {
  repo: string
  change: string
  title: string
  item: string
  provider: string
  reason: string
  priority: number | null
  blocked_by: string[]
}

const localSpecsyncPath = "/Users/andreas/dev/specsync/specsync"

function runSpecsync(args: string[], cwd?: string): Effect.Effect<{ code: number; stdout: string; stderr: string }, never, never> {
  return Effect.promise(() =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      // Try local specsync binary first (has query/claim/release commands),
      // fall back to the default specsync in PATH.
      const bins = [localSpecsyncPath, "specsync"]
      let lastResult: { code: number; stdout: string; stderr: string } | null = null

      const tryNext = (idx: number) => {
        if (idx >= bins.length) {
          resolve(lastResult ?? { code: 1, stdout: "", stderr: "no specsync found" })
          return
        }
        const bin = bins[idx]
        const proc = Bun.spawn([bin, ...args], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        })
        // Timeout after 5 seconds to prevent hanging
        const timer = setTimeout(() => {
          proc.kill()
          resolve({ code: 1, stdout: "", stderr: "specsync command timed out" })
        }, 5000)
        Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(([stdout, stderr]) => {
          clearTimeout(timer)
          proc.exited.then((code) => {
            lastResult = { code, stdout, stderr }
            // If the command succeeded, use it; otherwise try the next binary.
            if (code === 0) {
              resolve(lastResult)
            } else {
              tryNext(idx + 1)
            }
          })
        })
      }
      tryNext(0)
    }),
  )
}

/**
 * Checks whether a repository has a tracker binding by looking for
 * .specsync/board.json with at least one non-empty binding.
 */
function hasTrackerBinding(repo: string): boolean {
  const boardPath = path.join(repo, ".specsync", "board.json")
  if (!fs.existsSync(boardPath)) return false
  try {
    const data = JSON.parse(fs.readFileSync(boardPath, "utf8"))
    if (!data.bindings) return false
    return Object.values(data.bindings).some((b: unknown) => {
      if (typeof b !== "object" || b === null) return false
      const binding = b as { item_id?: string }
      return !!binding.item_id && binding.item_id.trim() !== ""
    })
  } catch {
    return false
  }
}

/**
 * Calls specsync query to get claimable changes across repositories.
 * Returns an array of WorkItem or an empty array if specsync is unavailable.
 */
function querySpecsync(repos: string[]): Effect.Effect<WorkItem[], never, never> {
  return Effect.gen(function* () {
    const repoArg = repos.join(",")
    const result = yield* runSpecsync(["query", "-json", "-repo", repoArg])

    if (result.code !== 0) {
      // specsync not installed or other error — degrade to disk fallback
      return []
    }

    let parsed: QueryItem[]
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      return []
    }

    const items: WorkItem[] = []
    for (const q of parsed) {
      const openspecDir = path.join(q.repo, "openspec")
      const changeDir = path.join(openspecDir, "changes", q.change)
      items.push({
        repo: q.repo,
        change: q.change,
        title: q.title,
        item: q.item,
        reason: q.reason,
        priority: typeof q.priority === "number" ? q.priority : null,
        blockedBy: q.blocked_by ?? [],
        changeDir,
        openspecDir,
      })
    }
    return items
  })
}

/**
 * Discovers repositories to scan. If `repos` is provided, uses those directly.
 * Otherwise, scans sibling directories of `root` for openspec repos.
 */
function discoverRepos(root: string, repos?: string[]): string[] {
  if (repos && repos.length > 0) return repos
  const found: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    const candidate = path.join(root, entry.name)
    const openspecChanges = path.join(candidate, "openspec", "changes")
    if (fs.existsSync(openspecChanges)) {
      found.push(candidate)
    }
  }
  return found.sort()
}

/**
 * Returns the next work item from the cross-repository work source.
 * Asks specsync first; where a repository has no binding, falls back
 * to its openspec changes.
 */
export function getWorkItems(
  root: string,
  repos?: string[],
): Effect.Effect<WorkSourceResult, never, never> {
  return Effect.gen(function* () {
    const discovered = discoverRepos(root, repos)
    const errors: string[] = []
    const allItems: WorkItem[] = []

    if (discovered.length === 0) {
      return { items: [], scanned: [], errors: [] }
    }

    // Separate repos into synced (has tracker binding) and unsynced.
    const synced: string[] = []
    const unsynced: string[] = []
    for (const repo of discovered) {
      if (hasTrackerBinding(repo)) {
        synced.push(repo)
      } else {
        unsynced.push(repo)
      }
    }

    // Query synced repos via specsync.
    if (synced.length > 0) {
      const items = yield* querySpecsync(synced).pipe(
        Effect.orElseSucceed(() => [] as WorkItem[]),
      )
      allItems.push(...items)
    }

    // For unsynced repos, fall back to disk-based queue resolution.
    // This is the existing behavior: read openspec/changes/ and return
    // eligible changes.
    for (const repo of unsynced) {
      const openspecDir = path.join(repo, "openspec")
      if (!fs.existsSync(openspecDir)) continue
      try {
        const changesDir = path.join(openspecDir, "changes")
        if (!fs.existsSync(changesDir)) continue
        const entries = fs.readdirSync(changesDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue
          const changeDir = path.join(changesDir, entry.name)
          const proposalPath = path.join(changeDir, "proposal.md")
          if (!fs.existsSync(proposalPath)) continue
          const title = fs
            .readFileSync(proposalPath, "utf8")
            .split("\n")
            .find((l) => l.startsWith("# "))
            ?.replace(/^#\s+/, "") ?? entry.name
          allItems.push({
            repo,
            change: entry.name,
            title,
            item: "",
            reason: "fallback=disk",
            priority: null,
            blockedBy: [],
            changeDir,
            openspecDir,
          })
        }
      } catch (err) {
        errors.push(`failed to read ${repo}: ${err}`)
      }
    }

    return {
      items: allItems,
      scanned: discovered,
      errors,
    }
  })
}

/**
 * Claims a change by setting its stage to active and syncing to the tracker.
 * Returns true if the claim succeeded, false otherwise.
 */
export function claimChange(changeDir: string): Effect.Effect<boolean, never, never> {
  return Effect.gen(function* () {
    const repo = path.dirname(path.dirname(changeDir))
    const result = yield* runSpecsync(
      ["claim", "-change", path.basename(changeDir)],
      repo,
    )
    return result.code === 0
  })
}

/**
 * Releases a change by setting its stage back to backlog and syncing.
 * Returns true if the release succeeded, false otherwise.
 */
export function releaseChange(changeDir: string): Effect.Effect<boolean, never, never> {
  return Effect.gen(function* () {
    const repo = path.dirname(path.dirname(changeDir))
    const result = yield* runSpecsync(
      ["release", "-change", path.basename(changeDir)],
      repo,
    )
    return result.code === 0
  })
}
