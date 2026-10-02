# Tasks: swarm coordinator

## Phase 0: Decide scope against what exists

- [ ] 0.1 Read the skein conductor tasks (`live-session-conductor` slices 1–5) and mark each
      as absorbed here, deferred, or dropped. Record in this change's `findings.md`.
- [ ] 0.2 Inventory `loop/spec-queue/gates.ts` and `crew-loop` board code; the coordinator
      must reuse, not fork, them.
- [ ] 0.3 Spike: Claude Code lead → project server via a minimal MCP shim. Does a `tools/list`
      round trip work with the server's password auth?

## Phase 1: Core

- [ ] 1.1 Coordinator lease (DB row, TTL, heartbeat); two-holder test; takeover after kill.
- [ ] 1.2 Ledger table and replay.
- [ ] 1.3 `coordinator/gates.ts` data + closed-schema validation at load (observed-red on a
      wrong-typed file).
- [ ] 1.4 Completion fails closed with missing-evidence list; token-only test rejected.

## Phase 2: Rules and nudges

- [ ] 2.1 Rules table per D2, each with a table test over fixture roster/claims.
- [ ] 2.2 Nudge dedupe, backoff and budget; positive control (identical second condition
      does not resend); negative control (idle coordinator with no work writes nothing).
- [ ] 2.3 Escalation: one lead request, one `decide` item.

## Phase 3: Lead tools

- [ ] 3.1 `swarm_status|assign|nudge|stop` tools; reject calls from sessions without a lead
      grant (`lead-authority`).
- [ ] 3.2 `swarm_assign` end to end: claim → queue loop on target agent → ack → notice.
- [ ] 3.3 MCP shim per spike 0.3 (if viable).

## Phase 4: Standalone fallback

- [ ] 4.1 Lease-holder coordinator over the sidecar registry; document the degraded features.

## Phase 5: Live

- [ ] 5.1 Lead + three headless agents, one real backlog, one evening; record human
      interventions, nudges sent, escalations, merges.
- [ ] 5.2 Kill the server during the run; coordinator resumes from the ledger.
