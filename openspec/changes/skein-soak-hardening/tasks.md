# Tasks: skein-soak-hardening

## Phase 1: Soak harness

- [ ] 1.1 Build a soak harness that runs control plane + project servers + agents for a
      sustained period under realistic load.
- [ ] 1.2 An invariant checker that asserts, continuously: no lost work, no double-
      execution of non-idempotent ops, no orphaned claims, no leaked leases, no unbounded
      memory growth.

## Phase 2: Failure injection

- [ ] 2.1 Server kills (kill -9) at arbitrary points; restart; verify recovery from
      durable records + actual repo state, not transcripts.
- [ ] 2.2 Network partitions between control plane and project servers; verify claims are
      released and re-claimed, not lost.
- [ ] 2.3 Lease expiries and claim races; verify exactly-one-winner and no double-booking.
- [ ] 2.4 GPU/inference slot loss mid-execution; verify the work is re-queued, not
      silently dropped.

## Phase 3: Distributed soak

- [ ] 3.1 Multiple hosts, multiple repos, cross-repo dependencies; verify correct ordering
      and no double-claim.
- [ ] 3.2 Sustained soak (target duration per charter §21); collect the §17 metrics.

## Phase 4: Hardening pass

- [ ] 4.1 Fix each defect the soak reveals, with a regression test that fails without the
      fix.
- [ ] 4.2 Document the invariants and the soak results in the change.
