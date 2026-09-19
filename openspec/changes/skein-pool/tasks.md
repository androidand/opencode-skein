# Tasks: skein-pool

## Phase 1: Context truth stays fresh

- [x] 1.1 Confirmed at the source instead: llama-skein `internal/fit/fit.go:505-512` divides
      `max_safe_ctx` by `--parallel`; opencode adopts it as `limit.context`
      (`provider.ts:1698`). No host currently runs `--parallel > 1` to measure against.
- [x] 1.2 Reproduce the stale case: raise `--parallel` on a running host mid-session and
      show opencode keeps the old `limit.context` until a 413
      Added `test/provider/provider.test.ts` "adjustLocalContextOnOverflow: stale
      limit.context after a mid-session --parallel raise corrects on 413": opencode
      caches `limit.context = 100000` at discovery (`--parallel = 1`); the operator later
      raises `--parallel` to 4, so the host now advertises `max_safe_ctx = 25000` from
      `/api/fit`, but nothing re-probes just because the fit changed mid-run — the cached
      value stays stale. A prompt sized for the old ceiling then 413s on the new one, and
      `adjustLocalContextOnOverflow` re-probes and writes the fresh `25000` through, so the
      next turn compacts against the corrected budget. `bun test test/provider/provider.test.ts`
      = 114 pass, 0 fail.
- [x] 1.3 `pick` returns the chosen model's fresh `maxSafeCtx`; `task.ts` writes it through
      `Provider.setModelContextLimit(..., "keep")` (context only, ceiling untouched)

## Phase 2: Peers as a placement pool

- [x] 2.1 `peer/delegate.ts` `pickPeer`: idle only, Claude Code peers first, opencode peers
      only when their model is not on a local host (that host is already a `host`
      candidate); unit tests. Peers are the fallback after every host is full — not
      scored against hosts, since a peer holds no slot opencode can measure.
- [x] 2.2 Task envelope: `[peer-task <id>]` header with reply address, reply tool and
      deadline; reply marker `[peer-task-result <id>]`; same text over both transports
      (Claude UDS envelope, opencode synthetic prompt); tests
- [x] 2.3 `task.ts` delegates when the parent host is `no-slot` and no idle host exists
      (`experimental.peer_delegation`, default on); replies are intercepted in the Claude
      sidecar `deliver` and in `send_peer_message` and settled as the task result;
      background/foreground/timeout paths unchanged
- [x] 2.4 Deadline: the existing `SUBAGENT_TASK_TIMEOUT_MS` bounds the delegated wait too;
      expiry surfaces as a task error the parent is notified of (absorbs
      `ctx-aware-subagent-placement` task 5 for the delegated path)
- [x] 2.6 Cross-process routing (`peer/route.ts`): a sibling opencode session owned by
      another process is reached over its owner's sidecar socket, never prompted from the
      sender's process; the owner mirrors busy/idle into its registry entry so `peers`
      reads truth instead of guessing from recency; sidecars now run without Claude Code
      installed. Found by the gpuhost4 test (2026-09-18) where opencode↔opencode A2A did not work.
- [ ] 2.5 Live: local parent on a full host + idle Claude Code peer → task lands on the peer,
      reply arrives as the task result; same with an idle opencode peer on a cloud model

## Phase 3: Leases on the host (llama-skein)

- [ ] 3.1 llama-skein: `POST/DELETE /api/slots/lease`, TTL expiry, leases counted in
      `inference.free`; `leased`/`holders` in `/api/hardware`; OpenAPI + tests
- [ ] 3.2 opencode: acquire a lease when placing on a host that supports it, release with
      the existing handle; fall back silently on 404
- [ ] 3.3 Live: two opencode processes fan out onto one single-slot host — exactly one
      places there, the other goes elsewhere or inherits

## Phase 4: Roster shows capacity

- [x] 4.1 `LocalPlacement.hostCapacity`: `peers` tool lists local hosts with free/total slots,
      in-process reservations and loaded model; `opencode agents --json` returns
      `{ agents, hosts }`; TUI Peers block gets a Host/Slots table. (`leased`/holders wait
      for Phase 3.) Claude peers now report `canPrompt` truthfully (alive + messaging on).
- [x] 4.2 `bun typecheck` (opencode, tui) clean; `bun test test/tool/task test/peer test/agent
      test/local/placement` 167 pass

## Phase 5: Bookkeeping

- [ ] 5.1 Archive `provider-slot-leases`, `peer-messaging`; trim `fleet-instance-presence`
      to Phase 3 + 4.1–4.3 or archive it; tick `ctx-aware-subagent-placement` task 5 with
      a pointer here
