# Tasks: reconcile the OpenSpec queue for the v2 route

The classification table is in this change's proposal; each task applies it.

- [ ] 1.1 Amend the amend-rows' proposals with a dated revision note citing this
      change (acp-external-verification, ahp-host, project-server first — they shape
      the most trust).
- [ ] 1.2 Write supersede headers into crew-loop, loop-done-handoff,
      model-gallery-ui, per-model-placement-controls ("carried into <port slug>"),
      and the matching "carries" citation in each port change's proposal.
- [ ] 1.3 Merge `fix-queue-branch-awareness`'s open tasks into the loop port's queue
      tasks; mark the original with the merge note.
- [ ] 1.4 Archive `sidecar-orphan-cleanup` with the PR #113 evidence line.
- [ ] 1.5 Re-anchor `long-session-memory-retention`'s proposal against upstream v2's
      context behavior; record what was fork-internal and is now upstream.
- [ ] 1.6 Mark the hold-rows (`loop-unattended-permission-asks`,
      `models-picker-ux`) with their pending-verification dependency
      (`adopt-upstream-acp-and-service` 1.1 evidence).
- [ ] 1.7 Run `openspec validate` across the queue; specsync dry-run the changes;
      re-sync changed rows (`specsync -change <slug>` per row or batch, owner's call on
      when).
- [ ] 1.8 Evidence: the queue listing with no unclassified active change; any row that
      needed a decision the register lacked goes to `08-risk-register.md` decision
      debt instead of a guess.
