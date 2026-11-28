#!/usr/bin/env bun
/**
 * fork-verify — prove the fork's custom surface survived an upstream sync.
 *
 * Reads fork/manifest.json and checks that:
 *   - every `owned` file (fork-only, can't content-conflict but CAN be dropped
 *     during conflict resolution) still exists, and
 *   - every `patched` upstream file still exists AND still contains its marker
 *     string (the fingerprint of our edit), and
 *   - every `divergence.accepted` entry still matches the content it was
 *     accepted at (see `acceptedStatus` — a path alone is not an exemption).
 *
 * This is the safety net for the exact failure the fork keeps hitting: a patch
 * silently disappearing in a merge. Run it after every sync, before merging the
 * sync branch back into dev.
 *
 *   bun run fork:verify
 *   bun run fork:verify --record-divergence   # re-pin accepted entries to HEAD
 *   bun run fork:verify --accept-divergence   # re-baseline the accepted set (pinned)
 *
 * Exit codes: 0 = clean, 1 = a regression was introduced (or a known
 * regression is still outstanding when --strict is passed).
 */
import fs from "fs"
import path from "path"

/** Pin for an accepted file the fork deliberately does not have. */
export const ABSENT = "absent"
const HEX = /^[0-9a-f]{64}$/

export type Patched = { file: string; marker: string; note?: string; status?: string }
export type AcceptedEntry = { file: string; hash: string; note?: string }
/** A bare string is accepted only as a *problem*: it pins nothing. See `validateAccepted`. */
export type Accepted = string | AcceptedEntry
export type Divergence = { scope: string[]; accepted: Accepted[]; note?: string }
export type Manifest = {
  fork: string
  owned: string[]
  patched: Patched[]
  baseline: { upstreamRef: string }
  divergence?: Divergence
}
export type HeadReader = (rel: string) => string | undefined

export const parseManifest = (text: string): Manifest => JSON.parse(text) as Manifest

export const acceptedFile = (entry: Accepted) => (typeof entry === "string" ? entry : entry.file)

export const sha256 = (content: string) => new Bun.CryptoHasher("sha256").update(content).digest("hex")

export const registeredFiles = (manifest: Manifest) =>
  new Set<string>([...manifest.owned, ...manifest.patched.map((p) => p.file)])

/**
 * Validate the accepted list as *instructions*, before touching git or the filesystem.
 *
 * The hole this closes: an accepted entry used to be a path, so the divergence gate skipped
 * the file whatever its contents became — 93 in-scope files with real fork edits were
 * invisible that way. A path is not a claim about content, so every entry must carry one,
 * and an entry that can never be evaluated (out of scope) or that duplicates a registration
 * (which the gate checks first) must not pass either.
 */
export function validateAccepted(manifest: Manifest): string[] {
  const divergence = manifest.divergence
  if (!divergence) return []
  const registered = registeredFiles(manifest)
  const inScope = (file: string) => divergence.scope.some((g) => new RegExp(g).test(file))

  const problems: string[] = []
  for (const entry of divergence.accepted) {
    if (typeof entry === "string") {
      problems.push(
        `"${entry}" is a bare path: an accepted entry must pin content (run: bun run fork:verify --record-divergence)`,
      )
      continue
    }
    if (entry.hash !== ABSENT && !HEX.test(entry.hash)) {
      problems.push(`"${entry.file}" hash "${entry.hash}" is neither 64 hex characters nor "${ABSENT}"`)
    }
    if (registered.has(entry.file)) {
      problems.push(`"${entry.file}" is accepted and also registered in owned/patched`)
    }
    if (!inScope(entry.file)) {
      problems.push(`"${entry.file}" does not match divergence.scope, so the gate can never evaluate it`)
    }
  }
  return problems
}

export type AcceptedStatus = {
  /** Accepted entries whose committed content no longer matches their pin. */
  drifted: string[]
  /** Accepted entries that no longer differ from the baseline — the exemption has nothing to exempt. */
  stale: string[]
  fingerprinted: number
  absent: number
}

/**
 * Check each accepted pin against `HEAD`, not the worktree. What gets pushed is HEAD, and a
 * merge that reverts a fork edit lands in HEAD while the worktree can still look correct —
 * the same reason the owned/patched checks read HEAD.
 *
 * `diffed` is the set of files differing from `baseline.upstreamRef`; an accepted entry
 * outside it is stale (upstream caught up, or the edit was dropped and nobody noticed).
 */
export function acceptedStatus(manifest: Manifest, readHead: HeadReader, diffed: Set<string>): AcceptedStatus {
  const status: AcceptedStatus = { drifted: [], stale: [], fingerprinted: 0, absent: 0 }
  for (const entry of manifest.divergence?.accepted ?? []) {
    if (typeof entry === "string") continue
    const content = readHead(entry.file)
    if (entry.hash === ABSENT) {
      status.absent++
      if (content !== undefined) {
        status.drifted.push(`${entry.file}  (pinned as "${ABSENT}", now present in HEAD)`)
      }
      continue
    }
    status.fingerprinted++
    if (content === undefined) {
      status.drifted.push(`${entry.file}  (pinned, but missing from HEAD)`)
      continue
    }
    if (sha256(content) !== entry.hash) {
      status.drifted.push(`${entry.file}  (HEAD content no longer matches its accepted pin)`)
      continue
    }
    if (!diffed.has(entry.file)) status.stale.push(entry.file)
  }
  return status
}

/** A file's committed content at `ref`, or undefined when that ref does not carry it. */
export const gitHeadReader = (root: string, ref = "HEAD"): HeadReader => (rel) => {
  const proc = Bun.spawnSync(["git", "show", `${ref}:${rel}`], { cwd: root })
  return proc.exitCode === 0 ? proc.stdout.toString() : undefined
}

/** Files inside divergence scope that differ from baseline and are neither registered nor accepted. */
export function collectDivergence(manifest: Manifest, diffed: Set<string>): string[] {
  const divergence = manifest.divergence
  if (!divergence) return []
  const registered = registeredFiles(manifest)
  const accepted = new Set(manifest.divergence?.accepted.map(acceptedFile) ?? [])
  const inScope = (file: string) => divergence.scope.some((g) => new RegExp(g).test(file))
  return [...diffed].filter((f) => inScope(f) && !registered.has(f) && !accepted.has(f)).sort()
}

/**
 * Re-pin the accepted list. Entries keep their `note`; new entries get none. A file missing
 * from HEAD is pinned as `ABSENT`, which is a claim too — if it comes back, the pin fails.
 *
 * When `original` is given only the accepted array is replaced, so re-baselining does not
 * reformat the rest of a hand-maintained 900-line manifest into an unreviewable diff.
 */
export function recordAccepted(manifest: Manifest, readHead: HeadReader, files: string[], original?: string): string {
  const notes = new Map<string, string>()
  for (const entry of manifest.divergence?.accepted ?? []) {
    if (typeof entry !== "string" && entry.note) notes.set(entry.file, entry.note)
  }
  const accepted = [...new Set(files)].sort().map((file) => {
    const content = readHead(file)
    const entry: AcceptedEntry = { file, hash: content === undefined ? ABSENT : sha256(content) }
    const note = notes.get(file)
    return note ? { ...entry, note } : entry
  })
  manifest.divergence = { ...(manifest.divergence ?? { scope: [], accepted: [] }), accepted }
  if (original !== undefined) return replaceAccepted(original, accepted)
  return JSON.stringify(manifest, null, 2) + "\n"
}

/** Splice a new accepted array in place, leaving every other byte of the manifest alone. */
export function replaceAccepted(text: string, accepted: AcceptedEntry[]): string {
  const at = text.indexOf('"accepted"')
  if (at < 0) throw new Error("manifest has no divergence.accepted array to rewrite")
  const open = text.indexOf("[", at)
  if (open < 0) throw new Error("divergence.accepted is not an array")
  let depth = 0
  let close = -1
  let inString = false
  let escaped = false
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "[" || ch === "{") depth++
    else if (ch === "]" || ch === "}") {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close < 0) throw new Error("divergence.accepted array is not terminated")
  const indent = text.slice(text.lastIndexOf("\n", at) + 1, at).match(/^\s*/)?.[0] ?? "    "
  const body = accepted.map((entry) => formatAcceptedEntry(entry, `${indent}  `)).join(",\n")
  const array = accepted.length ? `[\n${body}\n${indent}]` : "[]"
  return text.slice(0, open) + array + text.slice(close + 1)
}

function formatAcceptedEntry(entry: AcceptedEntry, indent: string) {
  const flat = `${indent}${JSON.stringify(entry)}`
  if (flat.length <= 120) return flat
  const keys = Object.entries(entry).map(([key, value]) => `${indent}  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
  return `${indent}{\n${keys.join(",\n")}\n${indent}}`
}

const root = path.resolve(import.meta.dir, "..")

function main() {
  const strict = Bun.argv.includes("--strict")
  const worktreeOnly = Bun.argv.includes("--worktree-only")
  const manifestPath = path.join(root, "fork", "manifest.json")
  const manifest = parseManifest(fs.readFileSync(manifestPath, "utf8"))

  const head = gitHeadReader(root)

  // Both the working tree AND the committed state are checked. A marker present
  // in the worktree but missing from HEAD is exactly how the fork loses features
  // in practice — a stray `git checkout <ref> -- file` stages upstream's copy and
  // the next commit takes it along, leaving a checkout that looks correct while
  // what gets pushed does not. The pre-push hook would otherwise wave that
  // through. Passing --worktree-only skips the HEAD half (useful mid-edit).
  const readHead: HeadReader = worktreeOnly ? () => undefined : head
  const missingOwned: string[] = []
  const missingMarker: string[] = []
  const knownRegressed: string[] = []

  for (const rel of manifest.owned) {
    if (!fs.existsSync(path.join(root, rel))) missingOwned.push(rel)
    else if (!worktreeOnly && head(rel) === undefined)
      missingOwned.push(`${rel}  (present in worktree, MISSING FROM HEAD)`)
  }

  for (const p of manifest.patched) {
    const abs = path.join(root, p.file)
    const exists = fs.existsSync(abs)
    const inWorktree = exists && fs.readFileSync(abs, "utf8").includes(p.marker)
    const committed = worktreeOnly ? undefined : head(p.file)
    const inHead = worktreeOnly || (committed !== undefined && committed.includes(p.marker))
    if (inWorktree && inHead) continue
    if (typeof p.status === "string" && p.status.startsWith("REGRESSED")) {
      knownRegressed.push(`${p.file}  (marker "${p.marker}")`)
      continue
    }
    missingMarker.push(
      `${p.file}  (marker "${p.marker}"${exists ? "" : ", FILE MISSING"}${
        inWorktree && !inHead ? ", present in worktree but MISSING FROM HEAD" : ""
      })`,
    )
  }

  const line = (s: string) => process.stdout.write(s + "\n")
  line(`fork-verify: ${manifest.fork}`)

  const problems = validateAccepted(manifest)
  // Re-baselining is the migration path out of a bare-path manifest, so it must be able to
  // run while the manifest is still invalid. Everything else refuses to proceed.
  const rewriting = Bun.argv.includes("--accept-divergence") || Bun.argv.includes("--record-divergence")
  if (problems.length) {
    line(`\n✗ INVALID divergence.accepted (the gate cannot trust an entry that pins nothing):`)
    for (const p of problems.slice(0, 20)) line(`    ${p}`)
    if (problems.length > 20) line(`    … and ${problems.length - 20} more`)
    if (!rewriting) {
      line(`\nFAIL — ${problems.length} invalid accepted entrie(s).`)
      process.exit(1)
    }
    line(`\n… rewriting the accepted set from HEAD (--record-divergence / --accept-divergence).`)
  }

  const diffed = new Set(
    Bun.spawnSync(["git", "diff", "--name-only", manifest.baseline.upstreamRef], { cwd: root })
      .stdout.toString()
      .split("\n")
      .filter(Boolean),
  )
  const unregistered = collectDivergence(manifest, diffed)
  const accepted = acceptedStatus(manifest, readHead, diffed)

  line(`  owned files:   ${manifest.owned.length - missingOwned.length}/${manifest.owned.length} present`)
  line(`  patched files: ${manifest.patched.length - missingMarker.length - knownRegressed.length}/${manifest.patched.length} intact`)
  line(
    `  divergence:    ${unregistered.length} unregistered (${accepted.fingerprinted + accepted.absent} accepted pinned, ${accepted.drifted.length} drifted, ${accepted.stale.length} stale)`,
  )

  if (missingOwned.length) {
    line("\n✗ DROPPED owned files (fork features lost in merge):")
    for (const f of missingOwned) line(`    ${f}`)
  }
  if (missingMarker.length) {
    line("\n✗ LOST patch markers (custom edit reverted by merge):")
    for (const f of missingMarker) line(`    ${f}`)
  }
  if (accepted.drifted.length) {
    line("\n✗ ACCEPTED DIVERGENCE CHANGED (an accepted exemption no longer describes HEAD):")
    for (const f of accepted.drifted) line(`    ${f}`)
    line("  → classify it: register as owned/patched, revert as drift, or re-pin with:")
    line("      bun run fork:verify --record-divergence")
  }
  if (accepted.stale.length) {
    line(`\n⚠ stale accepted entries (no longer differ from baseline — nothing left to exempt):`)
    for (const f of accepted.stale.slice(0, 20)) line(`    ${f}`)
    if (accepted.stale.length > 20) line(`    … and ${accepted.stale.length - 20} more`)
  }
  if (knownRegressed.length) {
    line("\n⚠ known regressions still outstanding (flagged in manifest, re-apply when able):")
    for (const f of knownRegressed) line(`    ${f}`)
  }

  if (Bun.argv.includes("--accept-divergence")) {
    const scope = manifest.divergence?.scope ?? []
    const registered = registeredFiles(manifest)
    const inScope = (file: string) => scope.some((g) => new RegExp(g).test(file))
    const next = [...diffed].filter((f) => inScope(f) && !registered.has(f))
    fs.writeFileSync(manifestPath, recordAccepted(manifest, head, next))
    line(`\nre-baselined divergence: ${next.length} accepted file(s), pinned to HEAD`)
    process.exit(0)
  }

  if (Bun.argv.includes("--record-divergence")) {
    const files = (manifest.divergence?.accepted ?? []).map(acceptedFile)
    fs.writeFileSync(manifestPath, recordAccepted(manifest, head, files))
    line(`\nre-pinned ${files.length} accepted entries to their current HEAD content`)
    process.exit(0)
  }

  if (unregistered.length) {
    line("\n✗ UNREGISTERED divergence from upstream (classify as feature or revert as drift):")
    for (const f of unregistered) line(`    ${f}`)
    line("  → a fork feature belongs in fork/manifest.json (owned or patched).")
    line("  → drift should be reverted to upstream.")
    line("  → if it is neither, re-baseline with: bun run fork:verify --accept-divergence")
  }

  const newRegressions = missingOwned.length + missingMarker.length + unregistered.length + accepted.drifted.length
  if (newRegressions > 0) {
    line(`\nFAIL — ${newRegressions} new regression(s). Re-apply before merging the sync branch.`)
    process.exit(1)
  }
  if (strict && knownRegressed.length) {
    line(`\nFAIL (--strict) — ${knownRegressed.length} known regression(s) outstanding.`)
    process.exit(1)
  }
  line("\nOK — no new regressions." + (knownRegressed.length ? ` (${knownRegressed.length} known, non-blocking)` : ""))
}

if (import.meta.main) main()
