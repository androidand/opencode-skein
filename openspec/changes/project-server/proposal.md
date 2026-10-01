# Project server: one supervisor per project, many agents

Parent: `autonomous-swarm` (foundation; replaces the "depend on Go skein" assumption).

## Why

skein's pattern was one supervisor, many runners. opencode-skein inverted it: every
`opencode` launch starts its own server inside the process (`cli/cmd/tui.ts` spawns a
worker per TUI; `opencode serve` exists but is opt-in and nothing discovers it). The
consequences are the root of several swarm problems:

- All coordination state is per process and in memory: the loop registry (`loop.ts`
  `Ref<Map>`, not persisted), `PeerInbox`, pending reply correlation, the repeat guard,
  placement slot reservations, `recentPlacements`. Two sessions in two processes cannot see
  each other's state, so `crew-loop` has to bolt on a database table, a "one queue per
  directory" refusal, and a foreign-turn guard.
- A loop dies when its TUI closes. Agents are tied to terminal windows, which is the
  "one iTerm session per agent" cost.
- A2A between opencode sessions needs sockets, a registry directory and a sidecar per
  session even when both live on the same machine and project.
- There is nowhere to run a coordinator that is not itself somebody's TUI.

Already true and reusable: the server loads project instances per request via the
`x-opencode-directory` header, so one server can serve every worktree of a repo;
`opencode attach <url> [--session]` already connects a TUI to a running server;
`opencode run --attach` does the same for CLI runs.

## What Changes

1. **One server per repository** (identity = git common dir, so every worktree shares it),
   discovered through a registry record `<state>/servers/<repo-key>.json`
   `{url, pid, startedAt, authFile}`; liveness = pid alive + health ping. Bound to loopback
   or a unix socket, with a generated password in a 0600 file. Never unsecured.
2. **Auto-attach.** `opencode` in a repo looks up the record; healthy → attach as a
   client; absent or dead → start a detached `opencode serve` and attach. A TUI close
   detaches; it does not stop the server or the agents in it. Opt-out `--standalone`
   (today's behaviour). Ships behind `experimental.project_server`.
3. **Agents are sessions + loops owned by the server**, not processes. An agent can be
   observed or driven from a TUI client, a CLI (`opencode run --attach`), or by no client
   at all (headless). `opencode agent spawn --role <persona> [--change <slug>]` creates a
   worktree-backed session with a loop in the server; `opencode agent list|attach|stop`.
   The human can attach a TUI to any agent at any time — "talk to every individual"
   remains, without a window per agent.
4. **Durable loops.** Loop records move from the in-memory `Ref` to the shared database
   so a server restart resumes running agents instead of losing them (precondition for
   trusting a long-lived server).
5. **In-server A2A short-circuit.** Sessions in the same server exchange messages
   through the server's own inbox and status (no socket), keeping the envelope and the
   trust framing identical. Sidecars stay for Claude Code and cross-repo peers, so
   nothing in `peer-conversation-reliability` is thrown away.
6. **Cross-instance aggregation.** Session status is `InstanceState`, i.e. per directory,
   not per process. The server exposes one aggregated view over all worktree instances
   (the roster the coordinator reads).
7. **Supervision of the supervisor.** Crash containment: heavy work stays in child
   processes (shell tools already are); a watchdog restarts a wedged server; the first
   client to notice a dead record respawns it; recovery replays durable loops. State that
   matters lives in the database and files, never only in the server's memory (the old
   skein post-mortem's failure).

## Non-goals

- No machine-wide singleton; the unit is the repo. Cross-repo coordination stays on A2A
  sockets.
- No removal of standalone mode or of the sidecar/Claude Code path.
- No new wire protocol: the existing HTTP API, SSE events and `attach`.

## Risks

1. **Single point of failure.** One server crash stops every agent in the repo. Mitigation:
   durable loops, restart on death, `--standalone` escape hatch, a soak with a deliberate
   kill (Phase 5).
2. **Per-instance assumptions.** Code that treats module-level or `InstanceState` maps as
   "the process" may mis-scope when many worktrees share a server. Mitigation: audit list
   in `design.md`; cross-worktree tests.
3. **Security.** A long-lived local server is an attack surface. Mitigation: loopback or
   unix socket only, mandatory password, same-user file permissions.
4. **Memory growth** in a long-lived process (a known concern: `long-session-memory-retention`
   change). Mitigation: that change becomes a dependency for default-on.

## Impact

`cli/cmd/tui.ts`, `cli/cmd/serve.ts`, `cli/cmd/attach.ts`, `cli/cmd/run.ts`, new
`server/registry.ts` and `cli/cmd/agent.ts`, `loop/loop.ts` (persistence), `peer/*`
(in-server delivery), `session/status.ts` (aggregation), tests.
