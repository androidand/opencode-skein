import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import {
  ABSENT,
  acceptedStatus,
  collectDivergence,
  gitHeadReader,
  parseManifest,
  recordAccepted,
  sha256,
  validateAccepted,
  type Manifest,
} from "./fork-verify"

const SCOPE = ["^packages/[^/]+/(src|test)/"]

const manifest = (accepted: unknown[], extra: Partial<Manifest> = {}): Manifest =>
  parseManifest(
    JSON.stringify({
      fork: "test-fork",
      owned: ["packages/core/src/fork-only.ts"],
      patched: [{ file: "packages/core/src/patched.ts", marker: "// fork:" }],
      baseline: { upstreamRef: "deadbeef" },
      divergence: { scope: SCOPE, accepted },
      ...extra,
    }),
  )

const pinned = (file: string, content: string) => ({ file, hash: sha256(content) })
const headOf = (files: Record<string, string>) => (rel: string) => files[rel]

describe("fork-verify divergence gate", () => {
  test("an accepted entry that pins nothing is refused, not treated as an exemption", () => {
    const problems = validateAccepted(manifest(["packages/core/src/event.ts"]))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("packages/core/src/event.ts")
    expect(problems[0]).toContain("bare path")
  })

  test("a hash that is not a fingerprint is refused", () => {
    const problems = validateAccepted(manifest([{ file: "packages/core/src/event.ts", hash: "not-a-hash" }]))
    expect(problems).toEqual([expect.stringContaining("neither 64 hex characters")])
  })

  test("a file cannot be both registered and accepted", () => {
    const problems = validateAccepted(
      manifest([
        {
          file: "packages/core/src/patched.ts",
          hash: sha256("x"),
        },
      ]),
    )
    expect(problems).toEqual([expect.stringContaining("also registered")])
  })

  test("an accepted entry outside the scope is refused — it could never be evaluated", () => {
    const problems = validateAccepted(manifest([{ file: "README.md", hash: sha256("x") }]))
    expect(problems).toEqual([expect.stringContaining("does not match divergence.scope")])
  })

  test("a merge that reverts an accepted file's content is caught", () => {
    const file = "packages/core/src/ripgrep.ts"
    const m = manifest([pinned(file, "export const ripgrep = forkVersion")])
    const clean = acceptedStatus(m, headOf({ [file]: "export const ripgrep = forkVersion" }), new Set([file]))
    expect(clean.drifted).toEqual([])
    expect(clean.fingerprinted).toBe(1)

    // The merge took upstream's copy: HEAD no longer carries the fork edit.
    const reverted = acceptedStatus(m, headOf({ [file]: "export const ripgrep = upstreamVersion" }), new Set([file]))
    expect(reverted.drifted).toEqual([expect.stringContaining(file)])
  })

  test("a pin taken from a file that is missing from HEAD is reported, not skipped", () => {
    const file = "packages/core/src/event.ts"
    const m = manifest([pinned(file, "content")])
    expect(acceptedStatus(m, headOf({}), new Set([file])).drifted).toEqual([expect.stringContaining(file)])
  })

  test(`an "${ABSENT}" pin passes while the file is absent and fails when it returns`, () => {
    const file = "packages/core/src/effect/dfdf"
    const m = manifest([{ file, hash: ABSENT, note: "upstream committed it by accident" }])
    expect(acceptedStatus(m, headOf({}), new Set([file])).drifted).toEqual([])
    expect(
      acceptedStatus(m, headOf({ [file]: "File to save in:" }), new Set([file])).drifted,
    ).toEqual([expect.stringContaining(file)])
  })

  test("an accepted entry that no longer differs from the baseline is stale, not silently exempt", () => {
    const file = "packages/core/src/event.ts"
    const m = manifest([pinned(file, "same as upstream")])
    const status = acceptedStatus(m, headOf({ [file]: "same as upstream" }), new Set())
    expect(status.drifted).toEqual([])
    expect(status.stale).toEqual([file])
  })

  test("unregistered in-scope divergence is reported; registered, accepted and out-of-scope are not", () => {
    const m = manifest([pinned("packages/core/src/accepted.ts", "x")])
    const diffed = new Set([
      "packages/core/src/accepted.ts",
      "packages/core/src/registered.ts",
      "packages/opencode/src/fork-only.ts",
      "docs/notes.md",
      "packages/tui/src/drift.tsx",
    ])
    m.owned.push("packages/opencode/src/fork-only.ts")
    m.patched.push({ file: "packages/core/src/registered.ts", marker: "// fork:" })
    expect(collectDivergence(m, diffed)).toEqual(["packages/tui/src/drift.tsx"])
  })

  test("re-pinning writes fingerprints, keeps notes, and survives validation", () => {
    const file = "packages/core/src/event.ts"
    const m = manifest([{ file, hash: "stale", note: "kept" }])
    const next = parseManifest(recordAccepted(m, headOf({ [file]: "new content" }), [file, "packages/core/src/gone.ts"]))
    expect(validateAccepted(next)).toEqual([])
    expect(next.divergence?.accepted).toEqual([
      { file: file, hash: sha256("new content"), note: "kept" },
      { file: "packages/core/src/gone.ts", hash: ABSENT },
    ])
    expect(acceptedStatus(next, headOf({ [file]: "new content" }), new Set([file, "packages/core/src/gone.ts"])).drifted).toEqual([])
  })

  test("the fork's own manifest carries a pin for every accepted entry", () => {
    const real = parseManifest(fs.readFileSync(path.resolve(import.meta.dir, "..", "fork", "manifest.json"), "utf8"))
    expect(validateAccepted(real)).toEqual([])
    expect(real.divergence?.accepted.every((e) => typeof e !== "string")).toBe(true)
    expect(real.divergence?.accepted.length).toBeGreaterThan(0)
  })

  test("the fork's own manifest reports no accepted entry that drifted from HEAD", () => {
    const root = path.resolve(import.meta.dir, "..")
    const real = parseManifest(fs.readFileSync(path.join(root, "fork", "manifest.json"), "utf8"))
    const diffed = new Set(
      Bun.spawnSync(["git", "diff", "--name-only", real.baseline.upstreamRef], { cwd: root })
        .stdout.toString()
        .split("\n")
        .filter(Boolean),
    )
    const status = acceptedStatus(real, gitHeadReader(root), diffed)
    expect(status.drifted).toEqual([])
    expect(status.fingerprinted + status.absent).toBe(real.divergence?.accepted.length)
  })
})
