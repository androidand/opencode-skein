# Skein 2.0 — Migration Plan

How the system moves from the current state (`00-current-state.md`) to the target
(`03-target-architecture.md`) without losing work or breaking existing users. Each step is
behind a flag or an additive change, with a named rollback.

Repo: `androidand/opencode-skein`.

## 1. Principles

- **Additive first.** New planes (control plane, AHP host, dashboard) are separate
  processes; nothing existing changes until they are proven.
- **Flag-gated behavior changes.** The project server and durable loops go behind
  `experimental.project_server`; off = today's per-process behavior.
- **No data loss.** Durable records are written before the in-memory path is retired;
  recovery is proven by kill -9 tests before the flag is enabled by default.
- **One concern, one store.** SQLite for single-host runtime state; PostgreSQL for the
  distributed control plane. No dual-writes for the same concern.
- **Reversible.** Every step names its rollback.

## 2. Phased migration

| Phase | What moves | Flag / gate | Rollback |
|---|---|---|---|
| 1 | ACP fluent SDK 1.8 (done on `skein2/acp-sdk-1.8`) | compat switch kept | flip compat switch back |
| 1 | Independent ACP client verification | CI job | remove job (no behavior change) |
| 2 | Project server + durable loops + `DurableAgentExecution` | `experimental.project_server` | disable flag → per-process |
| 3 | Autonomous crew (claims, worktrees, delegation, lead) | per-feature flags | disable feature |
| 4 | Control plane (extract Go `skein` domain; PG store) | separate process | stop process; project servers still work standalone |
| 4 | Project-server registration | opt-in registration | unregister |
| 7 | AHP host (read projection) | separate process | stop host |
| 7 | Mission Control dashboard | separate app | remove app |
| Cross | Observability (OTel + correlation IDs) | exporter on/off | disable exporter |
| 8 | Soak + hardening | CI soak | n/a (test only) |

## 3. Data migration

- **Runtime state (SQLite → stays SQLite).** The project server's durable loops and
  `DurableAgentExecution` records live in the existing project store (SQLite, single-host).
  No migration — the store already exists; new tables are added.
- **Control-plane state (new PostgreSQL).** The distributed claims, workflow state, and
  cross-repo execution records are new; there is no legacy data to migrate. The Go `skein`
  `internal/store` (SQLite) remains for single-host runtime; the control plane adds a
  PostgreSQL store for cross-host state.
- **Tracker (no migration).** The specsync-backed tracker is already the authority for
  priority/dependencies; the control plane reads it, it is not migrated.
- **Leases (no migration).** llama-skein already owns leases; the control plane's broker
  requests through the existing lease API.

## 4. Compatibility and coexistence

- **Old and new coexist.** A deployment can run project servers standalone (no control
  plane) or with the control plane. The control plane is optional for single-repo work.
- **ACP clients.** The compat switch stays until `acp-external-verification` passes with an
  independent client; then it is removed (one follow-up commit).
- **Peer/A2A.** The envelope and framing are unchanged (ADR 5); only the pending-registry
  moves to durable storage.
- **Upstream.** The fork does not rebase (500–700 commit gap); migration steps do not
  assume an upstream merge.

## 5. Rollback runbook (summary)

1. **Project server misbehaves** → disable `experimental.project_server`; agents fall back
   to per-process behavior. Durable records are preserved.
2. **Control plane misbehaves** → stop the control plane process; registered project
   servers continue standalone; in-flight cross-repo claims are released for re-claim.
3. **AHP host / dashboard** → stop the process; the execution plane and ACP are untouched.
4. **OTel exporter** → disable; telemetry stops, behavior unchanged.
5. **ACP compat switch** → re-enable if the independent-client gate regresses.

## 6. Cutover criteria (flag → default-on)

A flag is enabled by default only when:

- Its kill -9 / crash-recovery tests pass (no lost work, no double-execution).
- The relevant soak (`skein-soak-hardening`) passes its invariants.
- The rollback was exercised at least once in a staging deployment.
