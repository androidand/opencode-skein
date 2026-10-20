# Skein 2.0 — Target Architecture

The target system, ownership boundaries, and dependency graph. Companion to
`02-architecture-decisions.md` (the *why*) and `06-work-breakdown.md` (the *what/when*).
Repo: `androidand/opencode-skein`.

## 1. The two-plane architecture

The system has two coordination planes with a named seam between them (ADR 1):

```
                 ┌─────────────────────────────────────────────┐
                 │            SKEIN CONTROL PLANE              │
                 │  (independent, cross-repo, no model turns)  │
                 │                                             │
                 │  • portfolio + work graph (deps, priority)  │
                 │  • distributed claims (PG, CAS + fencing)   │
                 │  • project-server registry                 │
                 │  • resource broker (llama-skein leases)     │
                 │  • ready-work (specsync tracker)           │
                 │  • execution records + reconciliation      │
                 └───────────────┬─────────────────────────────┘
                                 │ assigns work / tracks state
                 ┌───────────────┴─────────────────────────────┐
                 │        PROJECT SERVER (per repository)      │
                 │   (opencode-skein; owns runtime + agents)   │
                 │                                             │
                 │  • runtime sessions (ACP, fluent 1.8)      │
                 │  • durable loops + DurableAgentExecution   │
                 │  • project-local conductor (swarm-coord)   │
                 │  • worktree isolation + claims (local)     │
                 │  • headless + multi-client attach          │
                 └───────────────┬─────────────────────────────┘
                                 │ ACP (runtime interface)
                 ┌───────────────┴─────────────────────────────┐
                 │              AGENTS (processes)             │
                 │  opencode run --agent <role>  /  Claude Code │
                 └─────────────────────────────────────────────┘
```

Surfaces (read-only projections, never the workflow authority):

- **AHP host** — a synchronized, multi-client *read projection* of runtime session state
  (ADR 4). Reuses ACP as the runtime interface.
- **Mission Control** — a small independent dashboard reading the control-plane API + AHP
  projections (ADR 10).
- **Observability** — OTel + correlation IDs + diagnostic CLI, cross-cutting (ADR 11).

## 2. Ownership boundaries (single source of truth per concern, ADR 6/8)

| Concern | Authority | Not the authority |
|---|---|---|
| Work definitions | OpenSpec files (`openspec/specs/`) | control plane, tracker |
| Priority + dependencies | specsync-backed tracker | control plane |
| Execution claims | control plane (cross-repo) / project server (local) | tracker |
| Runtime sessions | project server | control plane |
| GPU/inference leases | llama-skein | control plane |
| AHP session state | AHP host (projection) | runtime, control plane |
| Authority grants | operator-issued durable grants | peer messages, lead self-claim |

The control plane **never runs a model turn**; it assigns work to registered project
servers / agents. The project server **never** re-derives priority; it asks the tracker.

## 3. Component inventory

| Component | Repo / package | Spec | Notes |
|---|---|---|---|
| Project server | `opencode-skein` `packages/opencode` | `project-server` | per-repo; durable loops; `DurableAgentExecution` |
| ACP adapter | `opencode-skein` | `acp-external-verification` | fluent SDK 1.8; independent-client gate |
| Project-local conductor | `opencode-skein` | `swarm-coordinator` | mechanical tick, no LLM |
| Control plane | Go `skein` (extract + extend) | `skein-control-plane` | reuses `internal/domain`, `funnel`, `supervisor`, `watchdog` |
| AHP host | new (independent) | `ahp-host` | read projection; ACP runtime |
| Mission Control | new web package | `mission-control` | reads control-plane + AHP |
| Observability | Go `skein` + project server | `skein-observability` | OTel + correlation IDs + CLI |
| Soak / hardening | cross-cutting | `skein-soak-hardening` | failure injection + invariants |
| Autonomous crew | `opencode-skein` | `autonomous-swarm` epic (#97) + children | claims, worktrees, delegation, lead authority |

## 4. Dependency graph (build order)

```
Phase 1  acp-external-verification        (independent; gates compat-switch removal)
Phase 2  project-server                   (durable loops, DurableAgentExecution)
         └─ autonomous-swarm epic (#97)   (claims, worktrees, delegation, lead)
Phase 4  skein-control-plane              (needs project-server registration)
         └─ skein-pool lease broker       (llama-skein)
Phase 7  ahp-host                         (needs ACP runtime)
         └─ mission-control               (needs control-plane API + AHP)
Cross    skein-observability              (correlation IDs across all planes)
Phase 8  skein-soak-hardening             (soaks everything above)
```

Details and the full phase→spec map are in `06-work-breakdown.md` §1 and §6.

## 5. Data flow for one work item

1. **Define** — an OpenSpec change + tasks.md entry in a repo.
2. **Prioritize** — specsync projects it to the tracker (priority, dependencies).
3. **Discover** — the control plane queries the tracker for claimable work (ready-work).
4. **Claim** — the control plane grants a claim (distributed CAS + fencing token); the
   project server enforces the local path-scope claim.
5. **Assign** — the control plane assigns to a registered project server; the server
   spawns/attaches an agent (`opencode run --agent <role>`).
6. **Execute** — the agent runs a model turn via ACP; the project server records a
   `DurableAgentExecution` row on every transition.
7. **Observe** — the AHP host projects the session state; Mission Control renders it;
   OTel emits correlated telemetry.
8. **Recover** — on crash, recovery reads the durable record + actual repo state (not the
   transcript) and does not re-run a non-idempotent op whose outcome is unknown.
9. **Release** — the claim is released on completion or server death; the tracker is
   updated via specsync.
