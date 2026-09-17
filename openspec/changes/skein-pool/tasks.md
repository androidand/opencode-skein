# Tasks: skein-pool

## Phase 1: Context truth stays fresh

- [ ] 1.1 Confirm live: a llama-skein host with `--parallel 2` advertises `max_safe_ctx` ≈
      half of `configured_ctx` in `/api/fit`, and opencode's `limit.context` for that model
      equals it after discovery
- [ ] 1.2 Reproduce the stale case: raise `--parallel` on a running host mid-session and
      show opencode keeps the old `limit.context` until a 413
- [ ] 1.3 `placement.ts` probe → update the live model's `limit.context` from the fresh
      `max_safe_ctx` (same write `adjustLocalContextOnOverflow` does); unit test

## Phase 2: Peers as a placement pool

- [ ] 2.1 `pick` candidate kind `peer` from the A2A roster: idle, not self, `canPrompt`,
      enough context for the estimated prompt, role `placement` honoured; hosts-first
      default; tests alongside `test/local/placement.test.ts`
- [ ] 2.2 Task envelope in `peer/`: id, instructions, reply-to, deadline; encoded for
      opencode (synthetic prompt) and Claude Code (UDS envelope) transports; codec tests
- [ ] 2.3 `task.ts` delegate path: send, correlate the reply by task id, surface it as the
      task result; `release` semantics unchanged
- [ ] 2.4 Deadline: one wall-clock ceiling for host and peer placements; on expiry re-place
      or inherit (absorbs `ctx-aware-subagent-placement` task 5)
- [ ] 2.5 Live: cloud parent + idle local opencode peer → task lands on the peer, reply
      arrives; same with an idle Claude Code peer

## Phase 3: Leases on the host (llama-skein)

- [ ] 3.1 llama-skein: `POST/DELETE /api/slots/lease`, TTL expiry, leases counted in
      `inference.free`; `leased`/`holders` in `/api/hardware`; OpenAPI + tests
- [ ] 3.2 opencode: acquire a lease when placing on a host that supports it, release with
      the existing handle; fall back silently on 404
- [ ] 3.3 Live: two opencode processes fan out onto one single-slot host — exactly one
      places there, the other goes elsewhere or inherits

## Phase 4: Roster shows capacity

- [ ] 4.1 `peers` tool and `opencode agents --json` include per-host `slots`, `in_flight`,
      `leased`, holder names; TUI Peers table gets a capacity column
- [ ] 4.2 `bun typecheck`, `bun run fork:verify`, `bun test test/local test/peer`

## Phase 5: Bookkeeping

- [ ] 5.1 Archive `provider-slot-leases`, `peer-messaging`; trim `fleet-instance-presence`
      to Phase 3 + 4.1–4.3 or archive it; tick `ctx-aware-subagent-placement` task 5 with
      a pointer here
