# Tasks: project server

## Phase 0: Spikes (answers decide the rest)

- [x] 0.1 (works; shared projectID — see findings.md) Two worktrees of this repo in ONE `opencode serve` via `x-opencode-directory`: create
      a session in each, run a prompt in each concurrently. Record what breaks.
- [ ] 0.2 (NOT TESTED: needs a terminal) `opencode attach <url> --session <id>` against a session whose loop is running with
      no other client: does the TUI show live loop state; does closing the TUI leave the loop
      running (expected yes, the loop lives in the server)?
- [x] 0.3 (sessions survive, loops do not — findings.md) Kill the server mid-loop. Record exactly what is lost (loop registry is an in-memory
      `Ref`; expect: everything). This is the baseline D4 must beat.
- [x] 0.4 (only per-directory InstanceState needs aggregating — findings.md) Audit the D6 list: for each map, state its scope (process / instance / session) and
      whether two worktrees in one server would collide or fail to see each other.
- [x] 0.5 (yes after first status; one 204 MB sidecar process each — findings.md) Do headless sessions register sidecars and appear in `peers` for Claude Code peers?
- [~] 0.6 (partial: single-run numbers in findings.md; the 4-hour run is not done) Memory over a 4-hour, 3-agent run in one server vs three TUIs. Baseline for the
      overhead argument.

## Phase 1: Registry and auto-attach (behind `experimental.project_server`)

- [ ] 1.1 `server/registry.ts`: repo key, record schema (closed, validated at read), stale
      detection by pid + procStart + health, exclusive-create start lock. Observed-red tests:
      dead pid, reused pid, wrong schema type, concurrent start.
- [ ] 1.2 Detached spawn with mandatory generated password in 0600 file; loopback/unix only;
      refuse non-loopback.
- [ ] 1.3 `opencode` and `opencode run` auto-attach per D2; `--standalone`; `server
      stop|status|restart`; build-id mismatch handling.
- [ ] 1.4 TUI close detaches without stopping the server (verify against 0.2).

## Phase 2: Durable loops

- [ ] 2.1 Loop record table and write-through on every patch.
- [ ] 2.2 Re-adopt on server start; fresh child session per iteration; abandoned-turn handling.
- [ ] 2.3 Test: kill -9 the server mid-iteration; restart; loop continues; no duplicate
      iteration; claim heartbeat lapses then resumes. Seen red against current code first.

## Phase 3: Agents without processes

- [ ] 3.1 `agent spawn|list|attach|stop` over worktree + session + loop.
- [ ] 3.2 `headless` flag in the roster; reattach shows full history.
- [ ] 3.3 Cleanup: stopping an agent releases claim and optionally the worktree.

## Phase 4: In-server A2A and aggregation

- [ ] 4.0 (from the 0.5/0.6 findings) Host the per-session unix sockets inside the server, or in one multiplexing sidecar, instead of one 200 MB child process per registered session; register a session at creation, not at first status.

- [ ] 4.1 `Roster` service across instances (D6) with tests over two worktrees.
- [ ] 4.2 In-server delivery path in `send_peer_message` and `peers`; sender identity
      server-attributed; same framing and repeat guard.
- [ ] 4.3 Fix each D6-audit finding that mis-scopes (one commit per map, each with a test).
- [ ] 4.4 Relax the "one queue loop per directory" refusal for crew mode, in coordination with
      `crew-loop` 1.3 (shared claims make it safe).

## Phase 5: Supervision and soak

- [ ] 5.1 Watchdog heartbeat and client-side respawn.
- [ ] 5.2 Soak: three agents, deliberate kill of the server every 30 minutes for 4 hours;
      assert no lost work and no duplicated commits.
- [ ] 5.3 Memory comparison against 0.6; decide whether `long-session-memory-retention` must
      land before default-on.
- [ ] 5.4 Decide default-on for this fork.
