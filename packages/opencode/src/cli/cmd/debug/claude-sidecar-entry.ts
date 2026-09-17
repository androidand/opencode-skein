import { cmd } from "../cmd"
import { runSidecarEntry } from "@/peer/claude/sidecar-entry"

// Internal — spawned by sidecar-manager.ts, never invoked directly by a
// person. A compiled single-file binary doesn't ship sidecar-entry.ts as a
// standalone file the way `bun run <path>.ts` needs, so the sidecar runs as
// a subcommand of the same executable instead.
export const ClaudeSidecarEntryCommand = cmd({
  command: "claude-sidecar-entry",
  describe: false,
  async handler() {
    await runSidecarEntry()
  },
})
