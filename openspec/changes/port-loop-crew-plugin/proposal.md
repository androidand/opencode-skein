# Port `loop/` + `crew/` + `spec-queue/` to a plugin (P1.5), with claim fencing

Parent: Phase 1a item P1.5 (3.9k LOC; rewrite expected — `loop.ts` is 105 KB and its
hook points are gone in opencode 2). Depends on `plugin-repo-layout` and slots after
`port-peer-plugin` (delegation ledger precedes loop completion messaging).

## Why

The autonomous loop is the platform's engine: it claims ready work, runs it in isolated
worktrees, and hands off on completion (charter §8.5–8.8). In the fork this lives in a
105 KB `loop.ts` hooking upstream internals that opencode 2 has removed — so this port
is a rebuild against the plugin surfaces, guided by the existing spec suite
(`crew-loop`, `swarm-coordinator`, `loop-done-handoff`, `escalate-before-idle`,
`loop-spec-queue`, `fix-queue-branch-awareness`) and the landed behavior:
`loop-completion-contract`, the `--auto` flag and its Phase 5–6 tests
(`52516a57eb`, `d5cf928208`, `7b31baa46f`, `c509c05cb4`, `70d6c7c41a`, `1ecc4db407`,
`a97d9b7ec4`), and crew claims as shared files (`813393f21a`).

## What Changes

1. Rebuild the loop engine as the `skein-loop-crew` plugin package: spec-queue-driven
   work claims, execution, and completion handoff, keeping the landed behaviors above
   observable (drained vs found-nothing distinction, aggregated report, fenced auto
   runs, claim/release for cancellation).
2. Add claim fencing (charter §8.5): lease token, expiry, heartbeat, and a monotonic
   ownership generation so an expired worker cannot continue publishing stale work.
   Before reassignment, reconcile actual process/branch state — a stale heartbeat does
   not prove execution is stopped.
3. Register the skein worktree implementation via `worktree.transform`; worktree naming
   stays linked to work item + execution ID; no auto-delete of unmerged work (§8.6).
4. Completion handoff (§8.7) drives the next assignment from the workflow engine's own
   turn (record outcome → validate evidence → unlock downstream → assign ready work),
   never from an unbounded prompt loop (§23).
5. Role/capacity routing decisions stay llama-skein-tenant and policy-driven
   (`per-model-placement-controls` carries). The scheduling loop performs no LLM calls
   (§23).

## Non-goals

- No global control-plane duties (charter §9.1 — `skein-control-plane` owns cross-repo).
- No new work-source authority: spec-queue remains the only claimable-work source until
  the P1.9/P1.5 ready-work contract lands.

## Risks

- Rewrite scope is the known schedule risk (K2); ship the engine behind the landed
  behavior tests, growing coverage rather than porting the 105 KB blob verbatim.
- Claims data must survive plugin reloads — the shared-file claims store carries over;
  fencing tokens must be introduced atomically with adoption of the shared store.

## Impact

`skein-loop-crew` plugin: spec queue + claims + fencing + handoff + worktree transform.
This is where crew autonomy becomes durable; unblocks `autonomous-swarm`-epic work and
the soak phase.
