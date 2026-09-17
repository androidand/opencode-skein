// `opencode agents [--json]` — the same shape of question `claude agents
// --json` answers ("what live agent sessions exist on this machine right
// now"), for opencode-skein's own sessions, merged with Claude Code's if a
// live Claude registry is present. See openspec/changes/claude-code-peer-source.
import type { Argv } from "yargs"
import { Effect, Option } from "effect"
import { effectCmd } from "../effect-cmd"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LocalPlacement } from "@/local/placement"
import { Provider } from "@/provider/provider"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { resolveMessageTargets } from "@/session/peers"
import { GitBranch } from "@/util/git-branch"
import { listClaudePeers } from "@/agent/presence-claude"
import { EOL } from "os"

interface AgentRecord {
  owner: "opencode-skein" | "claude-code"
  id: string
  title?: string
  directory: string
  branch?: string
  status: string
  agent?: string
  provider?: string
  model?: string
}

export const AgentsCommand = effectCmd({
  command: "agents",
  describe: "list live agent sessions on this machine — opencode-skein and Claude Code",
  builder: (yargs: Argv) =>
    yargs.option("json", {
      describe: "output as JSON, like `claude agents --json`",
      type: "boolean",
      default: false,
    }),
  handler: Effect.fn("Cli.agents")(function* (args) {
    const flags = yield* RuntimeFlags.Service
    const session = yield* Session.Service
    const status = yield* SessionStatus.Service
    const permission = yield* Permission.Service
    const provider = Option.getOrUndefined(yield* Effect.serviceOption(Provider.Service))

    const [sessions, statuses, permissions] = yield* Effect.all([session.list(), status.list(), permission.list()])
    const branches = yield* Effect.promise(() => GitBranch.currentBranches(sessions.map((item) => item.directory)))

    // Not scoped to a caller: this is a whole-machine listing, like `claude
    // agents --json` — includeIdle so a quiet session still shows up.
    const opencodePeers = resolveMessageTargets({
      sessions: sessions.map((item) => ({
        id: item.id,
        parentID: item.parentID,
        directory: item.directory,
        title: item.title,
        agent: item.agent,
        model: item.model ? { providerID: item.model.providerID, id: item.model.id } : undefined,
        updatedAt: item.time.updated,
      })),
      statuses,
      pendingPermission: new Set(permissions.map((item) => item.sessionID)),
      loops: [],
      callerID: "",
      branches,
      now: Date.now(),
    })

    const claudePeers = yield* Effect.promise(() =>
      listClaudePeers({
        enabled: !flags.disableClaudeCodePeerSource,
        messaging: !flags.disableClaudeCodePeerMessaging,
      }),
    )

    const records: AgentRecord[] = [
      ...opencodePeers.map(
        (peer): AgentRecord => ({
          owner: "opencode-skein",
          id: peer.sessionID,
          title: peer.title,
          directory: peer.directory,
          branch: peer.branch,
          status: peer.status,
          agent: peer.agent,
          provider: peer.provider,
          model: peer.model,
        }),
      ),
      ...claudePeers.map(
        (peer): AgentRecord => ({
          owner: "claude-code",
          id: peer.sessionID,
          directory: peer.directory,
          status: peer.status,
        }),
      ),
    ]

    const hosts = provider
      ? yield* provider.list().pipe(
          Effect.flatMap((providers) => Effect.promise(() => LocalPlacement.hostCapacity(providers))),
          Effect.orElseSucceed(() => [] as LocalPlacement.HostCapacity[]),
        )
      : []

    if (args.json) {
      console.log(JSON.stringify({ agents: records, hosts }, null, 2))
      return
    }

    if (records.length === 0) {
      console.log("No agent sessions found.")
      return
    }

    const lines = records.map((r) => {
      const place = r.branch ? `${r.directory} @ ${r.branch}` : r.directory
      const label = r.title ?? "(unnamed)"
      return `${r.owner.padEnd(14)}  ${r.status.padEnd(18)}  ${place}  — ${label} [${r.id}]`
    })
    for (const host of hosts) {
      const slots = !host.reachable
        ? "unreachable"
        : host.slotsTotal !== undefined
          ? `${host.free}/${host.slotsTotal} slots free`
          : host.free > 0
            ? "idle"
            : "busy"
      lines.push(`${"host".padEnd(14)}  ${slots.padEnd(18)}  ${host.providerID}${host.loadedModel ? `  — ${host.loadedModel}` : ""}`)
    }
    console.log(lines.join(EOL))
  }),
})
