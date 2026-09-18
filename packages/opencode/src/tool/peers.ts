import { Effect, Option, Schema } from "effect"
import { fetchClaudeAgentRecords } from "@/agent/presence-claude"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LocalPlacement } from "@/local/placement"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { foreignRoster, liveSessionIDs } from "@/peer/route"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import {
  byRelation,
  coordinationAdvice,
  describeFleet,
  describePeer,
  idlePeers,
  relationTo,
  resolveMessageTargets,
  resolvePeers,
} from "@/session/peers"
import { GitBranch } from "@/util/git-branch"
import DESCRIPTION from "./peers.txt"
import * as Tool from "./tool"

/** How many recent sessions machine-wide to project a roster from. */
const MachineRosterLimit = 200

/** Headings for relation groups that contain only Claude Code peers, where `byRelation` produced no group. */
const RelationNotes: Record<string, string> = {
  "same-worktree": "your working tree — divide the work or you will overwrite each other",
  "same-repo": "the same repository, another worktree — shared branches and history, separate files",
  elsewhere: "a different repository — no file collision; coordinate on interfaces, not edits",
}

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
          // Machine-wide, like send_peer_message: `session.list()` alone is
          // scoped to this project, so a peer working in another repo — which
          // this tool explicitly promises to show — never appeared.
          const [own, everywhere, statuses, permissions, caller] = yield* Effect.all([
            session.list(),
            session.listGlobal({ limit: MachineRosterLimit }),
            status.list(),
            permission.list(),
            session.get(ctx.sessionID).pipe(Effect.orElseSucceed(() => undefined)),
          ])
          const byID = new Map<string, (typeof everywhere)[number]>()
          for (const item of [...everywhere, ...own]) byID.set(item.id, item as (typeof everywhere)[number])
          const sessions = [...byID.values()]

          const [claudePeers, foreign, live, hosts] = yield* Effect.all([
            Effect.promise(() => fetchClaudeAgentRecords({ enabled: !flags.disableClaudeCodePeerSource })),
            Effect.promise(() => foreignRoster()),
            Effect.promise(() => liveSessionIDs()),
            provider
              ? provider.list().pipe(
                  Effect.flatMap((providers) => Effect.promise(() => LocalPlacement.hostCapacity(providers))),
                  Effect.orElseSucceed(() => [] as LocalPlacement.HostCapacity[]),
                )
              : Effect.succeed([] as LocalPlacement.HostCapacity[]),
          ])

          const directories = [
            ins.directory,
            ...sessions.map((item) => item.directory),
            ...claudePeers.map((c) => c.cwd),
          ]
          // The repository each directory belongs to, so "another worktree of
          // my repo" is distinguishable from "a different project". They call
          // for opposite things: one is a division of work, the other is a
          // conversation about an interface.
          const [branches, repos] = yield* Effect.all([
            Effect.promise(() => GitBranch.currentBranches(directories)),
            Effect.promise(() => GitBranch.repoRoots(directories)),
          ])

          const projection = {
            sessions: foreign.merge(
              sessions.map((item) => ({
                id: item.id,
                parentID: item.parentID,
                directory: item.directory,
                title: item.title,
                agent: item.agent,
                model: item.model ? { providerID: item.model.providerID, id: item.model.id } : undefined,
                updatedAt: item.time.updated,
              })),
            ),
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
            repos,
            foreign: foreign.statuses,
            live,
            now: Date.now(),
          }
          const peers = resolvePeers(projection)
          // Idle sessions are the NORMAL target for send_peer_message, so a
          // discovery answer that omits them is the reason an agent decides a
          // session it was told about does not exist.
          const allTargets = resolveMessageTargets(projection)
          // "Idle" alone would put a session someone is sitting at next to one
          // whose process exited days ago. Only the attended ones are offered
          // as targets; the rest are counted, because a session nobody will
          // pick up is not a peer, it is a row.
          const idle = idlePeers(
            allTargets.filter((peer) => peer.reachable),
            peers,
          )
          // A dormant session is not uniformly a dead end: one in THIS project
          // can still be prompted by this process, so its turn really runs —
          // just with nobody watching. One elsewhere has no address at all.
          const ownIDs = new Set<string>(own.map((item) => item.id))
          const dormant = allTargets.filter((peer) => !peer.reachable)
          const dormantHere = dormant.filter((peer) => ownIDs.has(peer.sessionID)).length
          const dormantAway = dormant.length - dormantHere

          // A peer resolving "who am I" (e.g. so another session or the human
          // can address it back) needs its own id and title stated plainly —
          // this is a discovery tool, self-identification included.
          const selfLine = `You are session ${ctx.sessionID}${caller?.title ? ` — "${caller.title}"` : ""} in ${ins.directory}. Other sessions can message you with send_peer_message using this id, or an unambiguous prefix of your title.`

          const self = { directory: ins.directory, repo: repos.get(ins.directory) }
          const claudeEntries = claudePeers.map((claude) => {
            const branch = branches.get(claude.cwd)
            const place = branch ? `${claude.cwd} @ ${branch}` : claude.cwd
            const messageable = !flags.disableClaudeCodePeerMessaging
              ? "message with send_peer_message using its pid, session id, name, or directory"
              : "not currently messageable — Claude Code peer messaging is disabled on this instance"
            return {
              relation: relationTo(self, { directory: claude.cwd, repo: repos.get(claude.cwd) }),
              line: `- Claude Code session pid ${claude.pid}${claude.name ? ` — "${claude.name}"` : ""} [${claude.status ?? "unknown"}], ${place}, ${messageable}`,
            }
          })

          // Grouped by how each peer's work can collide with yours, because
          // that is what decides what coordinating even means: the same
          // working tree has to be divided, another worktree of the same repo
          // shares branches and history, and a different repository can only
          // be coordinated with on interfaces. Status alone never distinguished
          // those, so every peer read as the same kind of neighbour.
          const groups = byRelation(self, [...peers, ...idle.shown])
          const claudeByRelation = new Map<string, string[]>()
          for (const entry of claudeEntries) {
            const list = claudeByRelation.get(entry.relation)
            if (list) list.push(entry.line)
            else claudeByRelation.set(entry.relation, [entry.line])
          }
          const seen = new Set<string>()
          const rosterSection = [
            ...groups.flatMap((group) => {
              seen.add(group.relation)
              return [
                "",
                `${group.note}:`,
                ...group.peers.map((peer) => `- ${describePeer(peer)}`),
                ...(claudeByRelation.get(group.relation) ?? []),
              ]
            }),
            // Claude peers whose relation matched no opencode group still have
            // to appear; they are peers, not a footnote.
            ...[...claudeByRelation.entries()]
              .filter(([relation]) => !seen.has(relation))
              .flatMap(([relation, lines]) => ["", `${RelationNotes[relation] ?? relation}:`, ...lines]),
            ...(idle.omitted > 0 ? ["", `…and ${idle.omitted} more idle session(s), idle longer.`] : []),
          ]
          const dormantLine = [
            ...(dormantHere === 0
              ? []
              : [
                  "",
                  `${dormantHere} finished session${dormantHere === 1 ? "" : "s"} in this project ` +
                    `${dormantHere === 1 ? "has" : "have"} no one attending ${dormantHere === 1 ? "it" : "them"}. ` +
                    "A message still runs there, but nobody is watching the result — prefer a live peer.",
                ]),
            ...(dormantAway === 0
              ? []
              : [
                  "",
                  `${dormantAway} finished session${dormantAway === 1 ? "" : "s"} elsewhere on this machine ` +
                    `${dormantAway === 1 ? "has" : "have"} no live address at all and cannot be reached.`,
                ]),
          ]

          const totalOther = peers.length + claudeEntries.length + idle.shown.length

          // Joined with the roster rather than listed beside it: which session
          // holds which host is what decides whether work should go to a warm
          // colleague or to a freshly spawned subagent. See `describeFleet`.
          const hostSection = describeFleet([...peers, ...idle.shown], hosts)

          // An empty roster is a real, useful answer — say so rather than
          // returning a blank that reads like a failure.
          const output =
            totalOther === 0
              ? [
                  selfLine,
                  "",
                  "No other agent sessions are running anywhere on this machine right now.",
                  ...dormantLine,
                  ...hostSection,
                ].join("\n")
              : [
                  selfLine,
                  "",
                  `${totalOther} other agent session${totalOther === 1 ? "" : "s"} on this machine:`,
                  "",
                  ...rosterSection,
                  ...dormantLine,
                  ...hostSection,
                  "",
                  ...coordinationAdvice(groups),
                ].join("\n")

          return {
            title: totalOther === 0 ? "No other agents here" : `${totalOther} other agent session(s)`,
            // Metadata only. No message text, prompt, tool call or tool output
            // from another session is reachable through this.
            metadata: {
              self: { sessionID: ctx.sessionID, title: caller?.title },
              count: totalOther,
              peers,
              idlePeers: idle.shown,
              idlePeersOmitted: idle.omitted,
              dormant,
              claudePeers: claudePeers.map((c) => ({ pid: c.pid, name: c.name, cwd: c.cwd, status: c.status })),
              hosts,
            },
            output,
          }
        }),
    }
  }),
)
