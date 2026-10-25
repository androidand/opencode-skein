# Tasks: port loop/crew/spec-queue to plugin with fencing

Depends on `plugin-repo-layout` (isolation + repo name) and `port-peer-plugin` (the
ledger) for completion messaging.

- [ ] 1.1 Design the `skein-loop-crew` plugin structure against the landed behaviors:
      write design.md mapping each landed behavior/name to its plugin-boundary
      implementation, and mark which of the landed behaviors change shape in the
      rebuild (the drained/aggregation/fencing outcomes do not).
- [ ] 1.2 Rebuild spec-queue claiming over the shared-file claims store; the auto runs
      are fenced by QueueDenyRules as before; drain vs found-nothing distinction kept.
- [ ] 1.3 Add claim fencing: lease token + expiry + heartbeat + ownership generation;
      acquire in an atomic compare-and-swap over the claims store.
- [ ] 1.4 Reconcile-before-reassign: on expired heartbeat, inspect owning process
      availability + branch/worktree state first; tests cover both "recovered" and
      "still-alive" outcomes.
- [ ] 1.5 Register the skein worktree set via `worktree.transform`; naming links work
      item + execution ID; abandoned-worktree preservation rule enforced (§8.6).
- [ ] 1.6 Implement handoff-on-completion: record outcome, validate evidence, unlock
      downstream, assign next ready work; driver test: crew of 1 lead + 2 workers over
      a repo with ≥2 ready changes all assigning/rotating without human nudges
      (charter §8.9, Scenario C partial).
- [ ] 1.7 Keep the loop's cancellation semantics (claim/release lifecycle) and verify
      no nudge storms by a cap + reason-aware retry (§16.2/§16.4).
- [ ] 1.8 Before any further fork-side loop work: coordinate with
      `reconcile-openspec-queue-v2` (its claims/cancellation/handoff tasks merge here
      or get superseded — recorded there, not guessed).
- [ ] 1.9 Disposition of fork-side `loop/`/`crew/`/`spec-queue/` recorded for P1.7.
