#!/usr/bin/env bun

// Plain `build.ts` versions local/dev builds as `0.0.0-<channel>-<timestamp>` (@opencode-ai/script),
// which console.opencode.ai's free-tier gate now rejects as below its minimum supported version.
// This wraps build.ts with a real version/channel so local builds keep passing that check.
import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import pkg from "../package.json"

const dir = path.dirname(fileURLToPath(import.meta.url))
const branch = (await $`git branch --show-current`.text()).trim() || "local"

await $`bun run ${path.join(dir, "build.ts")} --single ${process.argv.slice(2)}`.env({
  ...process.env,
  OPENCODE_VERSION: process.env.OPENCODE_VERSION ?? `${pkg.version}-dev`,
  OPENCODE_CHANNEL: process.env.OPENCODE_CHANNEL ?? branch,
})
