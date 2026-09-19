// Regression test for lifecycle.ts deliver: verifies that forking on the app
// runtime (runForkWith context)) keeps Effect.log* off stdout, while forking
// on the default runtime leaks structured log lines.
//
// The bug: lifecycle.ts deliver was forked on the DEFAULT runtime, so every
// Effect.log* in an injected turn printed to stdout, corrupting the OpenTUI
// frame (externalOutputMode: "passthrough"). The fix is
// Effect.runForkWith(context) at lifecycle.ts:56.
//
// Run with: bun run <this-file> buggy|fixed
import { writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const mode = process.argv[2]
if (mode !== "buggy" && mode !== "fixed") {
  console.error("usage: bun run <this-file> buggy|fixed")
  process.exit(1)
}

// Import Effect and Observability layer.
// This script runs via `bun run` from the opencode package dir, so bare imports
// resolve through the package's node_modules (which has effect and
// @opencode-ai/core).
import { Effect, Layer, Logger } from "effect"
import * as Observability from "@opencode-ai/core/observability"

;(async () => {
  if (mode === "fixed") {
    // Fixed path: create a context from the observability layer (file logger),
    // then fork through runForkWith(context). The log goes to the file, not
    // stdout.
    const ctx = await Effect.runPromise(
      Effect.context<never>().pipe(Effect.provide(Observability.layer)),
    )
    Effect.runForkWith(ctx)(Effect.logError("probe-line"))
  } else {
    // Buggy path: fork on the DEFAULT runtime (console logger). The log goes
    // to stdout.
    Effect.runFork(Effect.logError("probe-line"))
  }

  // Wait for the fiber to flush.
  await new Promise((r) => setTimeout(r, 300))
})()
