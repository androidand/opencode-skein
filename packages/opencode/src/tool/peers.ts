import { Effect, Option, Schema } from "effect"
import { fetchClaudeAgentRecords } from "@/agent/presence-claude"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LocalPlacement } from "@/local/placement"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { foreignStatuses } from "@/peer/route"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { describePeer, resolvePeers } from "@/session/peers"
import { GitBranch } from "@/util/git-branch"
import DESCRIPTION from "./peers.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({})

export const PeersTool = Tool.define(
  "peers",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const status = yield* SessionStatus.Service
    const permission = yield* Permission.Service
    const flags = yield* RuntimeFlags.Service
    const provider = Option.getOrUndefined(yield* Effect.serviceOption(Provider.Service))

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const [sessions, statuses, permissions, caller] = yield* Effect.all([
            session.list(),
            status.list(),
            permission.list(),
            session.get(ctx.sessionID).pipe(Effect.orElseSucceed(() => undefined)),
          ])

          const [claudePeers, foreign, hosts] = yield* Effect.all([
            Effect.promise(() => fetchClaudeAgentRecords({ enabled: !flags.disableClaudeCodePeerSource })),
            Effect.promise(() => foreignStatuses()),
            provider
              ? provider.list().pipe(
                  Effect.flatMap((providers) => Effect.promise(() => LocalPlacement.hostCapacity(providers))),
                  Effect.orElseSucceed(() => [] as LocalPlacement.HostCapacity[]),
                )
              : Effect.succeed([] as LocalPlacement.HostCapacity[]),
          ])

          const branches = yield* Effect.promise(() =>
            GitBranch.currentBranches([...sessions.map((item) => item.directory), ...claudePeers.map((c) => c.cwd)]),
          )

          const peers = resolvePeers({
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
            // No loop state here: the Loop service depends on the prompt
            // layer, which depends on this registry, so a tool cannot import
            // it without a cycle. The queue brief runs INSIDE the loop and
            // passes the real loop info; a tool call sees status alone, which
            // is accurate because a loop-driven session is busy while it works.
            loops: [],
            callerID: ctx.sessionID,
            branches,
            foreign,
            now: Date.now(),
          })

          // A peer resolving "who am I" (e.g. so another session or the human
          // can address it back) needs its own id and title stated plainly —
          // this is a discovery tool, self-identification included.
          const selfLine = `You are session ${ctx.sessionID}${caller?.title ? ` — "${caller.title}"` : ""} in ${ins.directory}. Other sessions can message you with send_peer_message using this id, or an unambiguous prefix of your title.`

          const claudeLines = claudePeers.map((claude) => {
            const branch = branches.get(claude.cwd)
            const place = branch ? `${claude.cwd} @ ${branch}` : claude.cwd
            const messageable = !flags.disableClaudeCodePeerMessaging
              ? "message with send_peer_message using its pid, session id, name, or directory"
              : "not currently messageable — Claude Code peer messaging is disabled on this instance"
            return `- Claude Code session pid ${claude.pid}${claude.name ? ` — "${claude.name}"` : ""} [${claude.status ?? "unknown"}], ${place}, ${messageable}`
          })

          const totalOther = peers.length + claudeLines.length

          const hostLines = hosts.map((host) => {
            if (!host.reachable) return `- ${host.providerID}: unreachable`
            const slots =
              host.slotsTotal !== undefined
                ? `${host.free}/${host.slotsTotal} slot${host.slotsTotal === 1 ? "" : "s"} free`
                : host.free > 0
                  ? "idle"
                  : "busy"
            const held = host.reserved > 0 ? `, ${host.reserved} reserved by this instance` : ""
            const loaded = host.loadedModel ? `, ${host.loadedModel} loaded` : ""
            return `- ${host.providerID}: ${slots}${held}${loaded}`
          })
          const hostSection =
            hostLines.length === 0
              ? []
              : ["", "Local inference hosts (where a subagent can be placed):", ...hostLines]

          // An empty roster is a real, useful answer — say so rather than
          // returning a blank that reads like a failure.
          const output =
            totalOther === 0
              ? [
                  selfLine,
                  "",
                  "No other agent sessions are active anywhere on this machine right now.",
                  ...hostSection,
                ].join("\n")
              : [
                  selfLine,
                  "",
                  `${totalOther} other agent session${totalOther === 1 ? "" : "s"} active on this machine:`,
                  "",
                  ...peers.map((peer) => `- ${describePeer(peer)}`),
                  ...claudeLines,
                  ...hostSection,
                  "",
                  "If any of these overlaps what you are about to do, say so before you start.",
                ].join("\n")

          return {
            title: totalOther === 0 ? "No other agents here" : `${totalOther} other agent session(s)`,
            // Metadata only. No message text, prompt, tool call or tool output
            // from another session is reachable through this.
            metadata: {
              self: { sessionID: ctx.sessionID, title: caller?.title },
              count: totalOther,
              peers,
              claudePeers: claudePeers.map((c) => ({ pid: c.pid, name: c.name, cwd: c.cwd, status: c.status })),
              hosts,
            },
            output,
          }
        }),
    }
  }),
)
