// Branch-aware file reading for the spec queue.
//
// A loop iteration checks out a change's own branch (loop/<slug>) to do its
// work, but between turns the working tree can be left on a different branch —
// or a change's branch may not exist yet on a fresh clone. The queue and the
// per-iteration brief must read that change's tasks.md from the branch it
// actually lives on, not from whatever the current checkout happens to hold:
// reading the wrong one reports a stale "next task" and burns iterations
// re-doing work that is already done.
//
// `readChangeFile` answers one question — "what is the content of <relpath> for
// this change's branch?" — by trying, in order:
//
//   1. loop/<slug>:<relpath>   the change's own branch, via `git show`
//   2. <root>/<relpath>        the working tree, as a fallback
//
// If git is unavailable or `git show` fails (no branch, no commit, not a repo,
// git missing), the working tree is the source of truth, exactly as before this
// fix. Nothing here throws: a failed branch read degrades to the working tree,
// and a working tree that is also empty is simply `undefined`.

import fs from "fs"
import path from "path"

/** Absolute paths under root, relative to the change directory. */
export type ChangeRelPath = string

/**
 * The content of <relPath> for <slug>'s branch, or undefined when neither the
 * branch nor the working tree carry it.
 */
export function readChangeFile(root: string, slug: string, relPath: ChangeRelPath): string | undefined {
  const fromBranch = showRef(root, slug, relPath)
  if (fromBranch !== undefined) return fromBranch
  const file = path.join(root, relPath)
  if (!fs.existsSync(file)) return undefined
  return fs.readFileSync(file, "utf8")
}

/**
 * Reads <ref>:<relPath> from the change's own branch (loop/<slug>) without
 * touching the working tree. Returns undefined — never throws — when the branch,
 * the path, or git itself is unavailable, so callers can fall back to the working
 * tree.
 */
export function showRef(root: string, slug: string, relPath: ChangeRelPath): string | undefined {
  const ref = `loop/${slug}`
  const git = trySpawn(root, ["show", `${ref}:${relPath}`])
  if (git && git.exitCode === 0 && git.stdout.length > 0) return git.stdout
  return undefined
}

function trySpawn(
  cwd: string,
  args: string[],
): { exitCode: number; stdout: string } | undefined {
  try {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    return { exitCode: result.exitCode ?? -1, stdout: result.stdout.toString() }
  } catch {
    return undefined
  }
}

export * as BranchRead from "./branch-read"
