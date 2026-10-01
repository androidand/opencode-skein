# Design: project server

## Topology

```
          human                                   Claude Code lead / peers
   ┌──────┴───────┐                                        │  (sidecar sockets, unchanged)
 TUI client     CLI client                                  │
   │  attach        │  run --attach                          │
   └──────┬────────┘                                         │
          ▼                                                  ▼
 ┌────────────────────── project server (one per repo) ──────────────────────┐
 │ instances: <repo>, <repo-worktree-A>, <repo-worktree-B> … (x-opencode-dir) │
 │ agents  = session + loop (headless unless a client attaches)               │
 │ in-server A2A inbox/status      coordinator (design: swarm-coordinator)    │
 └───────────────┬────────────────────────────────────────────────────────────┘
                 ▼  shared SQLite (sessions, durable loops, claims, grants) + files
```

The server is the supervisor; agents are sessions it owns; clients are optional views.

## D1. Identity and discovery

`repo-key = hash(realpath(git common dir))`. Registry `<state>/servers/<repo-key>.json`:
`{version, url, pid, procStart, startedAt, authFile}`. A client is valid only if `pid` is
alive, `procStart` matches (guards pid reuse, same trick as the sidecar registry) and
`GET /health` answers. Anything else is a stale record, removed by the client that finds it.
Start race: creating the record uses an exclusive-create lock file; the loser attaches to
the winner.

Not in a git repo: fall back to the directory itself as the key.

## D2. Auto-attach flow

```
opencode [dir]:
  key = repoKey(dir)
  rec = readRecord(key)
  if rec healthy: attach(rec, dir)
  else: spawn detached `opencode serve --repo-key key` ; wait for record; attach
```

Detached means the server is not a child of the TUI (own session/process group), so closing
the terminal does not kill agents. `opencode server stop|status|restart` for the human.
Version skew: record carries the build id; a client with a different build refuses to attach
silently and offers `--standalone` or `server restart`.

## D3. Agents without processes

An agent is `{sessionID, directory(worktree), persona/model, loop record, claim}`.
`agent spawn` = create worktree via the existing `Worktree` service → create session in that
instance → start a loop (queue mode for a slug, or prompt). No new OS process. The
`peers`/roster view labels it `headless` until a client attaches. `agent attach <id>` is
`opencode attach <url> --session <id> --dir <worktree>`.

Capacity model unchanged: an agent still needs an inference slot; the project server just
sees all of them in one place, so the in-memory slot reservations stop being per-process lies
(for agents in this server).

## D4. Durable loops

Loop records written to the shared DB on every `patch`; on server start, records in
`running`/`paused`/`idle-watch` are re-adopted: iteration continues from the recorded state
with a fresh child session (the design already runs each iteration in a child session, so
there is no in-flight turn to recover). A turn that was mid-flight at the crash is
abandoned, and its claim heartbeat lapses and is resumed per `crew-loop` abandoned-claim
rules. Precondition for default-on.

## D5. In-server A2A

`send_peer_message` resolves the target first against the server's own sessions. Hit →
deliver through the in-process path (`PeerInbox`/`SessionPrompt`), same envelope, same
`formatPeerMessage` framing, same repeat guard. Miss → today's sidecar route. Sender identity
for in-server delivery is the session id the server itself attributes (not self-asserted),
which is strictly stronger than the socket check `lead-authority` uses for foreign peers. The
inbox and reply correlation maps stop being per-process for these sessions.

## D6. Aggregation across worktrees

Session status/Loop/Inbox state is scoped by `InstanceState` (directory). The server adds a
repo-level service `Roster` that walks live instances and returns one list
`{sessionID, directory, branch, status, loop, claim, headless}`. The coordinator and `peers`
read only this. Audit list (each must be checked and tested with two worktrees in one server):
`session/status.ts`, `peer/inbox.ts`, `peer/envelope.ts` pendingReplies,
`peer/repeat-guard.ts` instances, `peer/delegate.ts` pending, `local/placement.ts`
reservations and recentPlacements, `loop/loop.ts` registry, `worktree/*`.

## D7. Failure model

| failure | effect | recovery |
| --- | --- | --- |
| TUI client closes | none for agents | reattach |
| server process dies | agents stop | next client respawns (D2); durable loops re-adopted (D4) |
| server wedged (event loop stalled) | agents hang | watchdog heartbeat file; client or launchd restarts |
| one agent runaway (tool output, memory) | risk to all | tools already run as child processes; per-session limits; kill agent not server |
| port/record stale | attach fails | stale record removal (D1) |

## D8. Security

Loopback or unix socket only. Password mandatory for the auto-started server (random, in a
0600 `authFile` the client reads); `serve` run by hand keeps today's warning. The server
refuses non-loopback binds without an explicit flag. Peer authority from `lead-authority` is
unaffected: grants are verified, never trusted from the transport.

## Open questions

- Scope when the operator runs sessions in several unrelated repos: one server each is
  accepted; is there demand for a machine-wide "overseer" that talks to all project servers
  (that is the cross-repo lead — today a Claude Code session over A2A)?
- Should the default flip on, and when? Gate: soak with deliberate kill, memory retention
  change landed, and no regression of the 3-process crew spike.
