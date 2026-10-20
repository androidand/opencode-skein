# Change: skein-control-plane

## Why

Charter §9.1 requires cross-repository orchestration in an **independent** Skein control
plane, separate from the per-repository project server, so the platform can drive Claude
Code and other runtimes without a permanent OpenCode dependency.

Research (R6/R7) found the control plane is **already largely built** in the Go `skein`
repo (`github.com/androidand/skein`): `internal/domain` has the full work model
(`WorkRef`, `ClaimRequest`/`AdmitClaim` with path-scope conflict detection,
`WorkInventory`, `PortfolioSpec` with cross-repo `DependsOn`, P1–P5 priority,
checkpoints, dirty-path ownership, findings); `internal/funnel` has ready-task picking;
`internal/supervisor` has admission/aging/antiloop/assignment; `internal/watchdog` has
lease and stuck-recovery. Its store is SQLite (single-host).

This change **extracts and extends** that orchestration into the independent control
plane: a distributed store for cross-host claims, project-server registration, the
specsync ready-work contract, and the llama-skein resource broker. It does **not**
reimplement the domain model and does **not** run model turns.

## What Changes

- Extract the pure domain primitives (`WorkRef`, `ClaimRequest`, `AdmitClaim`,
  `ValidateClaimTarget`, `WorkInventory`, `PortfolioSpec`, `PathScope`) into a shared
  package the control plane and project servers both use — no duplication.
- Add a **distributed store** (PostgreSQL) for cross-host claims, workflow state, and
  execution records. Claims use transactional compare-and-swap with a fencing/ownership
  generation token (charter §8.5). The existing SQLite store remains for single-host
  runtime state.
- **Project-server registration**: each project server registers with the control plane
  (repo id, capabilities, reachable agents); the control plane tracks which repo is
  owned by which server.
- **Ready-work contract**: the control plane asks the specsync-backed tracker for
  claimable work (priority + dependencies) rather than re-deriving priority (charter
  §10.2, ADR 8).
- **Resource broker**: requests GPU/inference allocations through the llama-skein lease
  API; llama-skein remains the authoritative lease holder (ADR 7).
- **API + CLI surface**: `skein status|projects|agents|work|fleet|trace|doctor`
  (charter §17), reconciled with the existing Go `skein` CLI.
- Reuse `swarm-coordinator` primitives (gates, rules, nudge, claims) as the
  project-local conductor; the control plane owns cross-repo assignment only.

## Impact

- Affected specs: `skein-control-plane` (new), `swarm-coordinator` (boundary clarified),
  `auto-across-repos` (ready-work integration), `skein-pool` (lease broker).
- New Go service (or a new command in the existing `skein` binary) + PostgreSQL.
- A project-server registration protocol (new).
- No changes to the ACP runtime or the per-repo execution path.
