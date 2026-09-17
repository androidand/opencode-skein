#!/usr/bin/env bun

// Plain `build.ts` versions local/dev builds as `0.0.0-<channel>-<timestamp>` (@opencode-ai/script),
// which console.opencode.ai's free-tier gate now rejects as below its minimum supported version.
// This wraps build.ts with a real version/channel so local builds keep passing that check.
//
// The version also carries semver BUILD METADATA (the `+...` suffix) with a short commit sha
// and a build timestamp — restoring the per-build distinguishability the timestamp-based scheme
// above had, without reintroducing the low version number that broke the Zen gate. Per semver,
// build metadata is excluded from version precedence comparisons, so `>=1.17.0`-style checks
// still pass identically; only `opencode --version`'s exact string changes per build, which is
// the whole point — a stale binary and a freshly rebuilt one must be told apart at a glance
// (`opencode-skein/1.18.18-dev` looking the same before and after a rebuild is what caused this
// comment to be written).
import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import pkg from "../package.json"

const dir = path.dirname(fileURLToPath(import.meta.url))
const branch = (await $`git branch --show-current`.text()).trim() || "local"
const sha = (await $`git rev-parse --short HEAD`.text().catch(() => "unknown")).trim()
const dirty = (await $`git status --porcelain`.text()).trim().length > 0 ? "-dirty" : ""
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")

await $`bun run ${path.join(dir, "build.ts")} --single ${process.argv.slice(2)}`.env({
  ...process.env,
  OPENCODE_VERSION: process.env.OPENCODE_VERSION ?? `${pkg.version}-dev+${sha}${dirty}.${timestamp}`,
  OPENCODE_CHANNEL: process.env.OPENCODE_CHANNEL ?? branch,
})
