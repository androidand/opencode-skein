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
const sha = (await $`git rev-parse --short HEAD`.text().catch(() => "unknown")).trim()
const dirty = (await $`git status --porcelain`.text()).trim().length > 0 ? "-dirty" : ""
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")

// The channel picks which `opencode-<channel>.db` session database the built
// binary opens (core/src/database/database.ts). It used to default to
// `git branch --show-current`, so every differently-named branch a local
// build ran from silently forked off its own session history — a build from
// a feature branch made the whole session list "disappear" until you
// switched back. `sha`+`dirty`+`timestamp` in OPENCODE_VERSION already give
// every build a distinguishable identity, so the channel no longer needs to
// track the branch: pin it to a stable value and let a real channel split
// (e.g. isolated testing) be an explicit `OPENCODE_CHANNEL=` override.
await $`bun run ${path.join(dir, "build.ts")} --single ${process.argv.slice(2)}`.env({
  ...process.env,
  OPENCODE_VERSION: process.env.OPENCODE_VERSION ?? `${pkg.version}-dev+${sha}${dirty}.${timestamp}`,
  OPENCODE_CHANNEL: process.env.OPENCODE_CHANNEL ?? "dev",
})
