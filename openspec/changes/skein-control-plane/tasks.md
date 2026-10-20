# Tasks: skein-control-plane

## Phase 1: Domain extraction (reuse, don't duplicate)

- [ ] 1.1 Extract the pure domain primitives from `github.com/androidand/skein`
      `internal/domain` into a shared package: `WorkRef`, `PathScope`, `ClaimRequest`,
      `ClaimSnapshot`, `AdmitClaim`, `ValidateClaimTarget`, `WorkInventory`,
      `PortfolioSpec`, `PortfolioTask`, `ChangeSnapshot`, `TaskSnapshot`,
      `WorktreeSnapshot`, `DirtyPathSnapshot`, `WorkFinding`.
- [ ] 1.2 Keep the primitives storage- and transport-agnostic (pure functions; no
      SQLite/PostgreSQL import). Add unit tests for `AdmitClaim` scope-conflict cases
      (read/write overlap, change-level claims, same-task re-claim).
- [ ] 1.3 Confirm which existing `skein` packages the control plane reuses vs.
      re-homes (R6): `funnel` (ready-task), `supervisor` (admission/aging/antiloop),
      `watchdog` (lease/stuck-recovery). Document the boundary in the change.

## Phase 2: Distributed store

- [ ] 2.1 PostgreSQL schema for cross-host claims, workflow state, and execution
      records (mirrors the domain model; single source of truth per concern, ADR 6).
- [ ] 2.2 Transactional compare-and-swap claim grant with a fencing/ownership-generation
      token (charter §8.5). A stale claim cannot overwrite a newer generation.
- [ ] 2.3 Reconciliation loop: re-read live claims, expire lapsed leases, release
      orphaned claims (no blind re-run of non-idempotent work).
- [ ] 2.4 Test: two hosts race for the same task; exactly one wins; the loser gets a
      `ClaimRejection` naming the owner. Seen red against a naive store first.

## Phase 3: Project-server registration

- [ ] 3.1 Registration protocol: a project server registers (repo id, path, reachable
      agents, capabilities) and heartbeats; the control plane tracks ownership.
- [ ] 3.2 Deregistration on server death (heartbeat lapse); its in-flight claims are
      released for re-claim, not silently dropped.
- [ ] 3.3 The control plane never runs a model turn; it only assigns work to registered
      project servers / agents.

## Phase 4: Ready-work contract

- [ ] 4.1 Query the specsync-backed tracker for claimable work (priority + dependencies)
      — do not re-derive priority (ADR 8). **needs-research R5**: specsync is
      write-mostly; add a ready-work/claimable query (new specsync endpoint or
      control-plane-side tracker query).
- [ ] 4.2 Missing tracker binding → explicit safe fallback (no silent approval of
      unchecked tasks).
- [ ] 4.3 Cross-repo dependency resolution from `PortfolioTask.DependsOn`.

## Phase 5: Resource broker

- [ ] 5.1 Request GPU/inference allocations through the llama-skein lease API
      (`POST/DELETE /api/slots/lease`); llama-skein stays the authoritative lease holder
      (ADR 7).
- [ ] 5.2 Scheduling policy (model suitability, context, warm reuse, fairness) lives in
      the broker; the lease lives in llama-skein.
- [ ] 5.3 **needs-research**: llama-skein leases have no renewal or list endpoint
      (R4) — add renewal/list to llama-skein or model renewal client-side (owner
      decision).

## Phase 6: API + CLI

- [ ] 6.1 `skein status|projects|agents|work|fleet|trace|doctor` (charter §17),
      reconciled with the existing Go `skein` CLI conventions.
- [ ] 6.2 Correlation IDs on every operation (objective/work_item/execution/agent/
      session/turn/model_request/lease/trace) — feeds `skein-observability`.

## Phase 7: Cross-repo orchestration

- [ ] 7.1 Funnel: pick ready tasks across the portfolio, respecting dependencies,
      priority, and path-scope claims.
- [ ] 7.2 Assign to registered project servers; track execution records; nudge on
      stall (reuse `swarm-coordinator` primitives).
- [ ] 7.3 Test: a two-repo objective with a cross-repo dependency completes in the
      correct order; no double-claim.

## Phase 8: Distributed soak

- [ ] 8.1 Soak the distributed control plane (multiple hosts, multiple repos) — feeds
      `skein-soak-hardening`.
