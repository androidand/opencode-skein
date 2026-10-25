# Port `peer/` to a plugin (P1.4), with durable delegation

Parent: Phase 1a item P1.4 (2.7k LOC). Depends on `plugin-repo-layout`.

## Why

`peer/` is the agent-to-agent surface: the peer registry, message envelope, the Claude
Code sidecar (`peer/claude/`), and delegation (`peer/delegate.ts`). It works live today
(see the `review-*` finding worktrees), which makes it the least disposable of the fork
areas — porting it well matters more than porting it fast. Two known defects migrate
with it:

1. `peer/delegate.ts`'s pending-task reply registry is process-local memory — it cannot
   be the sole authority for durable delegation (charter §8.4). This is fixed *during*
   the port, not after (evaluation P1.4).
2. Peer content is untrusted unless authority is verified (charter §14.1) — carried in
   `lead-authority`; the port must not weaken envelope/session-identity checks along the way.

## What Changes

1. Port the peer tools into the `skein-peer` plugin package via the `tool` domain;
   the sidecar process lifecycle becomes plugin-owned (spawn/cleanup rules move with it).
2. Move delegation correlation from the in-memory reply registry to durable storage
   (plugin-owned; store choice recorded in design.md): durable task IDs, correlation
   IDs, deadline, retry policy, and a committed outcome ledger.
3. Delivery semantics per charter §8.4: at-least-once when retries are involved,
   idempotent processing, exactly-one committed outcome per work item via transactional
   state change; duplicate deliveries deduplicated on replay.
4. Keep `peer-conversation-reliability` as the reliability spec this implements; the
   runtime it assumed (fork internals) is replaced by plugin surfaces with the same
   guarantees.

## Non-goals

- No new peer protocol format; the existing envelope works and rewriting it to claim
  protocol compliance is charter-§5-forbidden.
- No review/claims logic here (P1.5 owns loop/crew state systems).

## Risks

- Sidecar orphaning on plugin reload — the fork learned this (`sidecar-orphan-cleanup`
  landed); the port must reproduce that cleanup or adopt its successor before going live.
- Durable storage inside a plugin keeps the in-process coupling question real (K3); the
  ledger writes must be crash-consistent under the isolation test evidence.

## Impact

`skein-peer` plugin + durable delegation ledger + re-pointed peer tests. Removes one of
the two deepest fork-internals dependencies that autonomy depends on (the other is the
loop, P1.5).
