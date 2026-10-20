# Skein 2.0 — Work Breakdown

Maps the master charter (`skein2-grand-plan.md`, phases 0–8, §20 scenarios A–H, §22 ADRs)
onto the existing OpenSpec changes and the new changes this breakdown introduces.
Every row is grounded in a file, branch, or issue — nothing here is assumed.

**Status legend:**
- **done** — implemented and evidenced (file/branch/commit cited).
- **partial** — implemented but a named gap remains.
- **specified** — an OpenSpec change exists; not yet implemented.
- **new** — a change this breakdown introduces (slug named; created or to be created).
- **needs-research** — an open question that must be answered before the work can be scoped
  without guessing. See the [needs-research register](#needs-research-register).

Repo: `androidand/opencode-skein`. All specsync commands pass `-repo androidand/opencode-skein`
(fork of `anomalyco/opencode`; auto-detect refuses to target the upstream parent).

---

## 1. Phase → spec map

### Phase 0 — Architecture reconciliation (this document set)

| Deliverable (charter §3) | State | Where |
|---|---|---|
| `00-current-state.md` | done | this worktree, commit `9d2bb46597` |
| `01-requirements.md` | new (planned) | next iteration |
| `02-architecture-decisions.md` (12 ADRs, §22) | new (planned) | next iteration; ADR→spec map in §5 |
| `03-target-architecture.md` | new (planned) | next iteration |
| `04-gap-analysis.md` (evidence matrix) | partial | matrix in §2 below; `04` will expand it |
| `05-migration-plan.md` | new (planned) | next iteration |
| `06-work-breakdown.md` | **done** | this file |
| `07-acceptance-tests.md` | new (planned) | next iteration; scenarios A–H in §3 |
| `08-risk-register.md` | new (planned) | next iteration |

### Phase 1 — ACP modernization (§6)

| Deliverable | State | Where |
|---|---|---|
| Fluent ACP SDK implementation | done | branch `skein2/acp-sdk-1.8`, `docs/skein-2/01-acp-migration.md` |
| Updated service adapters | done | same branch |
| Compatibility tests (unit) | partial | unit tests exist; external-client leg missing |
| External-client integration verification | **new** | `acp-external-verification` (created this iteration) |
| Remove deprecated `AgentSideConnection` deps | partial | compat switch still present; removed after external verification |

### Phase 2 — Durable project execution (§7)

| Deliverable | State | Where |
|---|---|---|
| Persistent per-project server | specified | `project-server` (#103) |
| Auto-attach | specified | `project-server` |
| Headless agent sessions | specified | `project-server` |
| Session lifecycle APIs (`agent spawn/list/attach/stop`) | specified | `project-server` |
| Durable loop execution | specified | `project-server` (Phase 2) |
| Crash recovery | specified | `project-server` (Phase 5) |
| Multi-client support | specified | `project-server` |
| Resource-usage validation | specified | `project-server` (0.6 / 5.3) |
| `DurableAgentExecution` record (§7.4) | **new (planned)** | amendment to `project-server` tasks |

### Phase 3 — Complete autonomous crew (§8)

| Deliverable | State | Where |
|---|---|---|
| Epic | specified | `autonomous-swarm` (#97) |
| Durable claims | specified | `crew-loop` + `swarm-coordinator` (#104) |
| Isolated worktrees | specified | `crew-loop` |
| Persistent delegation / structured results | specified | `peer-conversation-reliability` |
| Lead authority | specified | `lead-authority` (#98) |
| Crew role assignment | specified | `crew-loop` |
| Work-completion handoff | specified | `loop-done-handoff` (#101) + `escalate-before-idle` (#100) |
| Independent review | specified | `review-on-done` (#102) |
| Policy-gated integration | specified | `standing-publish-authority` (#99) |

### Phase 4 — Global control plane (§9)

| Deliverable | State | Where |
|---|---|---|
| Independent Skein coordinator | **new (planned)** | `skein-control-plane` — reconciles with `swarm-coordinator` (#104), see §4 |
| Project-server registration | new (planned) | `skein-control-plane` |
| Runtime adapters (opencode-skein, Claude Code) | new (planned) | `skein-control-plane` |
| Global work state / claims / recovery | new (planned) | `skein-control-plane` |
| Event processing + scheduler (§9.6–9.7) | new (planned) | `skein-control-plane` |
| Operator policy integration | new (planned) | `skein-control-plane` + `lead-authority` |

### Phase 5 — GPU and workload scheduling (§11)

| Deliverable | State | Where |
|---|---|---|
| llama-skein resource-lease integration | specified | `skein-pool` (#88); lease API confirmed in `llama-skein` (`apisleasing.go`) |
| Capacity-aware worker placement | specified | `skein-pool` + `per-model-placement-controls` (#12) |
| Warm-session reuse / model suitability | specified | `skein-pool` |
| Queue fairness | specified | `skein-pool` |
| Runtime resource telemetry | **new (planned)** | `skein-observability` |
| Opportunistic maintenance work | partial | `skein-pool` |

### Phase 6 — Cross-repository autonomy (§10)

| Deliverable | State | Where |
|---|---|---|
| specsync ready-work query integration | specified | `auto-across-repos` (#20); specsync gap in §4 |
| Dependency-aware scheduling | specified | `auto-across-repos` + `skein-control-plane` |
| Project discovery / multi-repo assignment | specified | `auto-across-repos` |
| Cross-repo integration evidence | specified | `auto-across-repos` |
| Global backlog processing | specified | `auto-across-repos` |

### Phase 7 — AHP and Mission Control (§12, §13)

| Deliverable | State | Where |
|---|---|---|
| AHP host (read-only first) | **new** | `ahp-host` (created this iteration) |
| Multi-client session sync + reconnection | new | `ahp-host` |
| Global dashboard | **new (planned)** | `mission-control` |
| Live agent detail / work graph / lead chat | new (planned) | `mission-control` (+ `swarm-coordinator` tools) |
| Approvals and notifications | new (planned) | `mission-control` + `escalate-before-idle` |

### Phase 8 — Hardening and soak testing (§16, §19)

| Deliverable | State | Where |
|---|---|---|
| Unattended multi-agent/multi-project/multi-host soak | **new (planned)** | `skein-soak-hardening` |
| Deliberate failure injection (crash, network, saturation) | new (planned) | `skein-soak-hardening` |
| Partial live-fleet verification | specified | `fleet-live-verification` (#89) |

### Cross-cutting

| Concern (charter §) | State | Where |
|---|---|---|
| Observability: OTel, correlation IDs, diagnostic CLI (§17) | **new (planned)** | `skein-observability` |
| Reliability / failure recovery (§16) | partial | `project-server` + `skein-control-plane` + `skein-soak-hardening` |
| Autonomy / permissions / trust (§14) | specified | `lead-authority` + `standing-publish-authority` + `escalate-before-idle` |
| Quality gates / verified outcomes (§15) | specified | `review-on-done` + `swarm-coordinator` gates + `loop-done-handoff` |

---

## 2. Evidence matrix (charter §3)

| Capability | Present state | Evidence | Missing work | Priority |
|---|---|---|---|---|
| ACP | Migrated to fluent SDK 1.8.0; unit-tested; external client unverified | branch `skein2/acp-sdk-1.8`; `docs/skein-2/01-acp-migration.md` | External-client verification (Scenario A); remove compat switch | P0 |
| A2A / peer | Implemented; pending-reply registry is process-local memory | `peer/delegate.ts`; `peer-conversation-reliability` spec | Durable delegation, correlation IDs, idempotent outcomes | P0 |
| Project server | Specified; spikes done (0.1, 0.3, 0.4, 0.5); not implemented | `project-server` spec + `findings.md` | Full Phase 2 implementation; `DurableAgentExecution` record | P0 |
| Autonomous crew | Partial; in-memory claims + loop registry | `crew-loop`, `swarm-coordinator` specs | Durable claims, handoff, independent review, policy gate | P0 |
| Control plane | `swarm-coordinator` is in-server; charter §9.1 prefers independent | `swarm-coordinator` spec vs charter §9.1 | Independent control plane (Go + PostgreSQL); reconcile scope | P1 |
| AHP | Not started | `microsoft/agent-host-protocol` spec; existing gateways (R2) | AHP host, read-only first (Scenario G) | P2 |
| Mission Control | Not started | — | Dashboard, agent detail, work graph, lead chat | P2 |
| Observability | Not started (no OTel) | — | OTel, correlation IDs, diagnostic CLI | P1 |
| GPU scheduling | `skein-pool` partial; llama-skein lease API exists | `skein-pool` spec; `llama-skein/internal/server/apisleasing.go` | Lease integration; placement corrections (§11.4) | P1 |
| Cross-repo | `auto-across-repos` specified; specsync is write-mostly | `auto-across-repos` spec; `specsync changes --json` | Ready-work/claimable query; dependency scheduling | P1 |

---

## 3. Scenario A–H → spec map (charter §20)

| Scenario | Proven by |
|---|---|
| A — ACP compatibility (external client drives a real session) | `acp-external-verification` |
| B — Detachment (close terminal, agent continues, reattach) | `project-server` |
| C — Autonomous crew (lead + 2 workers, independent defect review) | `autonomous-swarm` epic: `crew-loop` + `swarm-coordinator` + `lead-authority` + `review-on-done` + `loop-done-handoff` |
| D — Recovery (kill worker / project server, no duplicate merge) | `project-server` + `skein-soak-hardening` |
| E — GPU scheduling (saturate one host, no double-booking, warm reuse) | `skein-pool` + llama-skein lease integration |
| F — Cross-repository workflow (dependency-aware, concurrent independent work) | `auto-across-repos` |
| G — AHP synchronization (two clients, reconnect, correct reconciliation) | `ahp-host` |
| H — Overnight autonomy (mixed backlog, unattended, bounded failures) | `skein-soak-hardening` (composes all of the above) |

---

## 4. Reconciliations and known conflicts

1. **`swarm-coordinator` (#104) vs charter §9.1.** `swarm-coordinator` places coordination
   *inside* the opencode-skein project server. The charter explicitly prefers project-local
   supervision in opencode-skein **and** cross-repository orchestration in an *independent*
   Skein control plane. Resolution: `swarm-coordinator` stays as the **project-local**
   conductor (it already says "no LLM, mechanical tick, DB-backed lease"). The new
   `skein-control-plane` change owns **cross-repo** orchestration and reuses
   `swarm-coordinator`'s primitives (gates, rules, nudge, claims) rather than duplicating
   them. This must be written into both proposals before either is implemented.
   **needs-research R6** (which Go `skein` packages to reuse) and **R7** (PostgreSQL vs SQLite)
   gate the `skein-control-plane` scope.

2. **specsync is write-mostly.** `specsync changes --json` returns slug/title/stage/
   taskProgress/priority but **no** tracker item id, dependencies, or claimable/ready flag.
   The charter §10.2 "machine-readable ready-work contract" therefore needs either a new
   specsync read endpoint or a control-plane-side query over the tracker. **needs-research R5**
   (partially answered) gates the `auto-across-repos` ready-work task.

3. **llama-skein leases are in-memory, TTL-only.** Confirmed in
   `llama-skein/internal/server/apisleasing.go`: `POST /api/slots/lease` /
   `DELETE /api/slots/lease/{id}`, no renewal, no list endpoint. Charter §11.5 wants
   "lease IDs, expiration, renewal, and safe release." The `skein-pool` lease task must
   either add renewal/list to llama-skein or model renewal client-side. **needs-research**
   (llama-skein owner decision) — recorded, not guessed.

4. **Phase 0 audit's "missing OpenSpecs" was stale.** The audit (run against local `dev`
   `5fea944430`) reported #97–#104 missing; they exist on `origin/dev` (`813393f21a`).
   This breakdown is based on `origin/dev`.

---

## 5. ADR map (charter §22) → owning spec

| # | ADR | Owning spec / doc |
|---|---|---|
| 1 | Control plane boundary (separate vs in-process) | `skein-control-plane` |
| 2 | Project server ownership (lifecycle + persistence) | `project-server` |
| 3 | ACP adapter strategy | `acp-external-verification` + `01-acp-migration.md` |
| 4 | AHP host strategy (projection, commands, sync) | `ahp-host` |
| 5 | A2A strategy (peer transport, external interop) | `peer-conversation-reliability` |
| 6 | Durability (DB ownership, transactions, claims, events) | `project-server` + `skein-control-plane` |
| 7 | GPU scheduling (resource authority, model placement) | `skein-pool` |
| 8 | Work-source authority (OpenSpec/specsync/tracker) | `auto-across-repos` |
| 9 | Security (operator grants, action policies, enforcement) | `lead-authority` + `standing-publish-authority` |
| 10 | Frontend (separate Mission Control vs OpenCode UI) | `mission-control` |
| 11 | Observability (tracing, metrics, logs, audit) | `skein-observability` |
| 12 | Deployment (local, headless, distributed homelab) | `skein-control-plane` + `skein-soak-hardening` |

All twelve are written in `02-architecture-decisions.md` (next iteration).

---

## 6. Sequencing and dependencies

```
Phase 1 remainder  acp-external-verification   (no deps — start now)
        |
Phase 2           project-server               (foundation; needs Phase 1)
        |
        +--> Phase 3   autonomous-swarm epic    (needs project-server)
        |            (crew-loop, swarm-coordinator, lead-authority,
        |             review-on-done, loop-done-handoff, escalate-before-idle,
        |             standing-publish-authority, peer-conversation-reliability)
        |
        +--> Phase 4   skein-control-plane      (needs project-server; reconciles swarm-coordinator)
        |            (gates R6, R7)
        |
        +--> Phase 5   skein-pool + leases      (needs control plane + llama-skein)
        |
        +--> Phase 6   auto-across-repos        (needs control plane + specsync ready-work, R5)
        |
        +--> Phase 7   ahp-host                 (needs project-server)
        |            mission-control            (needs project-server + control plane)
        |
        +--> skein-observability                (cross-cutting; can start after project-server)
        |
Phase 8           skein-soak-hardening           (needs all of the above)
```

Critical path: `acp-external-verification` → `project-server` → `autonomous-swarm` →
`skein-control-plane` → `skein-soak-hardening`. `ahp-host`, `mission-control`,
`skein-observability`, `skein-pool`, `auto-across-repos` branch off `project-server` /
`skein-control-plane` and can proceed in parallel where staffed.

---

## 7. New changes introduced by this breakdown

| Slug | Phase | Scenario | Tracker |
|---|---|---|---|
| `acp-external-verification` | 1 | A | #118 |
| `ahp-host` | 7 | G | #119 |
| `skein-control-plane` | 4 | (enables C, D, F, H) | #120 |
| `mission-control` | 7 | (dashboard) | #121 |
| `skein-observability` | cross | (metrics/CLI) | #122 |
| `skein-soak-hardening` | 8 | D, H | #123 |

Plus: `project-server` amendment (`DurableAgentExecution`, §7.4, synced to #103) and
`02-architecture-decisions.md` (12 ADRs, §22).

---

## 8. Needs-research register

| ID | Question | Status | Blocks |
|---|---|---|---|
| R1 | Which external ACP client to verify against | **answered** — ACP v1 stable; official SDKs TS/Python/Rust/Kotlin/Java; Zed is the main client. Use a Python or Rust SDK client (independent of the TS SDK) or Zed. | `acp-external-verification` (unblocked) |
| R2 | AHP protocol shape + existing hosts | **answered** — JSON-RPC 2.0, channel-routed, `serverSeq` ordering, write-ahead reconciliation; existing hosts: VS Code agent host, `pi-ahp`, `ahpd` (`@ahpd/sdk`), `hydra-ahp`, `ahp-acp-gateway`. | `ahp-host` (unblocked) |
| R3 | Go `skein` repo structure | **answered** — 1090 Go files, 48+ internal packages (`supervisor`, `funnel`, `control`, `watchdog`, `peer`, `store`, `metrics`, `traces`). | `skein-control-plane` (partially) |
| R4 | llama-skein lease API | **answered** — `POST/DELETE /api/slots/lease`, in-memory, TTL, no renewal/list. | `skein-pool` lease task (partially) |
| R5 | specsync ready-work / claimable query | **partial** — `changes --json` works (write-mostly); no dependency/claimable query; fork refusal needs `-repo`. | `auto-across-repos` ready-work task |
| R6 | Which Go `skein` packages to reuse for the control plane | **answered** — the control plane is largely built: `internal/domain` (WorkRef, ClaimRequest/AdmitClaim, WorkInventory, PortfolioSpec, P1–P5, checkpoints, dirty-path ownership, findings), `internal/funnel` (ready-task), `internal/supervisor` (admission/aging/antiloop/assignment), `internal/watchdog` (lease/stuck-recovery). Extract the pure domain primitives; reuse the rest. | `skein-control-plane` (unblocked) |
| R7 | PostgreSQL vs SQLite for the control plane (single-host vs distributed) | **answered** — existing `internal/store` is SQLite (single-host runtime state). The distributed control plane uses PostgreSQL for cross-host claims/workflow; keep SQLite for single-host. ADR 6. | `skein-control-plane` (unblocked) |
| R8 | AHP host build approach: `ahp-acp-gateway` vs `@ahpd/sdk` vs build on the TS client lib | **open** | `ahp-host` design.md |
| R9 | Mission Control: extend OpenCode web UI vs small independent dashboard | **answered** — `packages/web` is `@opencode-ai/web`, an Astro docs site, not a dashboard; no existing control dashboard. Build a small independent dashboard (ADR 10 option B). | `mission-control` (unblocked) |
| R10 | OTel integration: SDK, exporter, correlation-ID propagation | **partial** — Go `skein` has `internal/metrics` (per-provider/model/stage, D1) + `internal/traces` but no OTel in go.mod. Add OTel where suitable, building on existing; correlation-ID set defined. Exact OTel SDK/exporter still open. | `skein-observability` (mostly unblocked) |
| R11 | `archsync` integration (§10.4) — separate concept | **open** | `auto-across-repos` (optional) |

---

## 9. Anti-goal check (charter §23)

| Anti-goal | How this breakdown respects it |
|---|---|
| No second coding-agent engine | Reuses opencode-skein as the execution plane |
| Don't replace working peer communication | Keeps A2A; improves via `peer-conversation-reliability` |
| Don't reimplement specsync tracker mapping | Uses specsync; adds a ready-work query (R5) |
| No parallel source of truth | Single-source-of-truth table (charter §9.4) enforced in `skein-control-plane` |
| No gigantic prompt-based scheduler | Event-driven + reconciliation loop; no LLM in the scheduler tick |
| Don't equate GPU saturation with productivity | `skein-pool` tracks verified-throughput metrics, not utilization |
| Don't assume "done" means complete | Quality gates + `review-on-done` + evidence records |
| Don't require terminal uptime | `project-server` detach semantics |
| Don't duplicate GPU lease authority | llama-skein is the authoritative lease holder |
| No large infra stack | No Kubernetes/Kafka; single-service control plane first |
