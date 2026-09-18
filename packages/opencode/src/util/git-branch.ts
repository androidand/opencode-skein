// Cheap, cached, best-effort current-branch lookup for a directory. Used to
// enrich cross-directory peer listings with "which branch is this session
// on" — never authoritative, never blocks the caller on a slow/broken repo.
import { Process } from "./process"

const CACHE_TTL_MS = 5_000
const cache = new Map<string, { at: number; branch: string | undefined }>()

export async function currentBranch(directory: string, now = Date.now()): Promise<string | undefined> {
  const cached = cache.get(directory)
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.branch

  let branch: string | undefined
  try {
    const out = await Process.text(["git", "-C", directory, "rev-parse", "--abbrev-ref", "HEAD"], {
      nothrow: true,
      timeout: 2_000,
    })
    branch = out.code === 0 ? out.text.trim() || undefined : undefined
  } catch {
    branch = undefined
  }
  cache.set(directory, { at: now, branch })
  return branch
}

/** Resolves branches for every distinct directory in one pass, deduplicated. */
export async function currentBranches(directories: readonly string[], now = Date.now()): Promise<Map<string, string>> {
  const unique = [...new Set(directories)]
  const resolved = await Promise.all(unique.map((dir) => currentBranch(dir, now)))
  const result = new Map<string, string>()
  unique.forEach((dir, i) => {
    const branch = resolved[i]
    if (branch) result.set(dir, branch)
  })
  return result
}

const repoCache = new Map<string, { at: number; repo: string | undefined }>()

/**
 * The repository a directory belongs to, identified by its git COMMON dir.
 *
 * Every worktree of one repository shares that path, while each has its own
 * `.git` file and its own branch — so this is what tells "another worktree of
 * the repo I am in" (shared branches and history, separate files) apart from
 * "a different repository entirely" (nothing shared). Same best-effort
 * contract as `currentBranch`: cached, never authoritative, never blocking.
 */
export async function repoRoot(directory: string, now = Date.now()): Promise<string | undefined> {
  const cached = repoCache.get(directory)
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.repo

  let repo: string | undefined
  try {
    const out = await Process.text(
      ["git", "-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { nothrow: true, timeout: 2_000 },
    )
    repo = out.code === 0 ? out.text.trim() || undefined : undefined
  } catch {
    repo = undefined
  }
  repoCache.set(directory, { at: now, repo })
  return repo
}

/** Resolves repositories for every distinct directory in one pass, deduplicated. */
export async function repoRoots(directories: readonly string[], now = Date.now()): Promise<Map<string, string>> {
  const unique = [...new Set(directories)]
  const resolved = await Promise.all(unique.map((dir) => repoRoot(dir, now)))
  const result = new Map<string, string>()
  unique.forEach((dir, i) => {
    const repo = resolved[i]
    if (repo) result.set(dir, repo)
  })
  return result
}

export * as GitBranch from "./git-branch"
