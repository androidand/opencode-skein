# Findings: project-server Phase 0 spikes (2026-10-02)

Method: a throwaway `opencode serve` (build b7d95c8427) on loopback with a password, in an isolated
data, state, config and Claude-registry directory (so nothing appeared as a peer to live sessions),
serving one git repo and one of its worktrees. No model provider was configured, so everything below
is about hosting, state and lifecycle, not inference. Numbers are single runs on one machine.

## 0.1 Two worktrees in one server: works

- A session can be created in either directory through the `x-opencode-directory` header or a
  `?directory=` query parameter.
- Both worktrees resolve to the SAME `projectID` (git common-dir identity). The design's repo key
  (D1) can therefore be the existing `projectID`; no new hashing is needed.
- `GET /session` from either directory returns every session of the project, across both
  worktrees. Cross-worktree session listing already exists; what does not is cross-worktree live
  status (see 0.4).

## 0.2 Attach: NOT TESTED

`opencode attach` needs a terminal; a non-TTY run is not meaningful. Needs the operator's terminal:
attach to a session whose loop is running with no other client, close the TUI, check the loop
survives.

## 0.3 Kill mid-run: sessions survive, loops do not (baseline for durable loops)

A queue loop with `queueWatch` stays alive without a model, so it stood in for a long-running agent.
After `kill -9` and a restart on the same data: the session was still listed (the database holds it);
`GET /loop` returned `[]`. The loop that was driving the session is gone with no record that it ever
existed. This is the exact behaviour D4 (durable loops) has to replace, and it confirms the loop
registry is memory-only.

## 0.4 Audit of the D6 maps

| state | scope | in a shared server |
| --- | --- | --- |
| `peer/inbox.ts` pending deliveries | process, keyed by session id | works unchanged; becomes coherent across worktrees |
| `peer/envelope.ts` pendingReplies, `peer/delegate.ts` pending | process | same |
| `peer/claude/sidecar-manager.ts` active | process, keyed by session id | same |
| `session/unattended.ts` policies, `session/compaction.ts` loop-break state | process, keyed by session id | same |
| `local/placement.ts` reservations, recentPlacements | process, keyed by provider | becomes correct for every agent in the server (was per terminal) |
| `loop/loop.ts` registry | one `Ref<Map>` per process | global to the server, already aggregates all directories |
| `session/status.ts`, `permission/index.ts`, `session/run-state.ts`, `session/instruction.ts` | `InstanceState`, per directory | the only genuinely per-worktree state: a roster must aggregate it |

Result: nothing collides. Only per-directory state needs an aggregating roster.

## 0.5 Headless sessions as peers: yes, but late and expensive

- A session created over HTTP is NOT registered as a peer at creation. After its first status report
  (a prompt, even one that fails) the server registered it: `managedBy: opencode-skein`, status
  idle, correct cwd. A freshly spawned agent is therefore invisible to other agents until it first
  runs. Cheap fix: ensure the sidecar at creation, or have the coordinator start its loop immediately.
- Each registered session gets its OWN sidecar process, `opencode debug claude-sidecar-entry`, which
  is a full copy of the binary: about 204 MB resident each, about 1% CPU idle.

## 0.6 Cost

| thing | resident | CPU idle |
| --- | --- | --- |
| headless server, 2 worktree instances, 4 sessions, no provider | 318 MB | about 0.5% |
| same server after ONE prompt attempt (provider path loaded) | 1,091 MB | 0% |
| one sidecar (per registered session) | 204 MB | about 1% |
| for comparison, an interactive session on the operator's machine | about 1.1 GB | 40-54% |

The first request to a fresh instance spiked to 92% CPU once (setup), then settled. Idle cost lives in
the per-terminal process, not in hosting sessions. Caveat: no providers, LSP or MCP were loaded.

## Consequences for the design

1. D1 stands, with `projectID` as the key.
2. D4 (durable loops) is confirmed necessary, with a measured baseline.
3. D5 (in-server delivery) is NOT enough on its own. Registration for Claude Code and cross-repo
   peers still costs one 200 MB process per agent, so ten agents would spend 2 GB on sidecars alone,
   which defeats the memory argument for a shared server. NEW REQUIREMENT: the project server hosts
   the per-session unix sockets itself (in process, or one multiplexing sidecar for the whole
   server) instead of one child process per session. This becomes its own task in Phase 4.
4. Register at creation (or immediately on spawn), so a spawned agent is addressable at once.
5. The CPU figure for interactive sessions is not explained by hosting. Profile one before blaming a
   feature (the OTLP collector approach in the operator's notes).
