# Skein 2.0 — Requirements

Charter §3 deliverable. Sources: `skein2-grand-plan.md` (the charter), the revised
phase plan in `skein2-plan-evaluation.md` §6–§7, the walking-skeleton proof in
`skein2-p1.2-findings.md`, and `06-work-breakdown.md` (which maps each requirement to
an owning OpenSpec change). Every requirement cites its charter section; every owning
spec is a real change in `openspec/changes/` or a named phase-1 port item (P1.x).

Written 2026-10-25 against the revised (opencode 2 plugin) phase structure.

---

## 1. Platform requirements

The system SHALL:

| # | Requirement | Charter | Owning spec / phase |
|---|---|---|---|
| R-A1 | Let one lead agent receive objectives, plan, delegate, and drive ready work, with the human talking only to the lead | §1.1–1.3, §8.3 | `lead-authority` + `mission-control` lead chat |
| R-A2 | Allow agents to collaborate over messages, ask for help, exchange structured results | §1.4, §8.4 | `peer-conversation-reliability`, made durable during P1.4 |
| R-A3 | Discover ready work from the existing OpenSpec/specsync ecosystem, not a new priority store | §1.5, §10.1–10.2 | `auto-across-repos` (P1.9 ready-work contract) |
| R-A4 | Advance work through research → plan → implement → test → review → integrate with verified evidence at each gate | §1.6–1.7, §15.1 | stage graph in `crew-loop`/`swarm-coordinator`; `review-on-done` |
| R-A5 | Stay productive while the operator is away, within explicit authorization boundaries | §1.8, §14 | `lead-authority`, `standing-publish-authority`, `escalate-before-idle` |
| R-A6 | Survive disconnects, terminal closure, restarts and recoverable failures with durable state | §1.9, §7, §16 | revised Phase 1-2: verify upstream `opencode service` vs §7.6; plugins keep durable loop state |
| R-A7 | Operate across repositories, machines, local models and agent harnesses as one environment | §1.10 | `skein-control-plane` (Go + PostgreSQL; server API / ACP, never fork internals) |
| R-A8 | Use local GPU resources for verified engineering throughput, not utilization vanity | §1.11, §11 | `skein-pool` + llama-skein lease authority (ADR 7) |
| R-A9 | Let one client see/control everything (dashboard), including commands like cancel/assign | §1.12, §13 | `mission-control` |
| R-A10 | Count work as completed only on verified evidence (tests, commits, review records), never on an agent's say-so | §1.13, §15.3 | gate record: `review-on-done`, `project-server` checkpoint rules |
| R-A11 | Remain modular and standards-based (ACP / AHP / A2A / MCP), so another agent or provider plugs in without rewriting orchestration | §1.14, §5 | execution plane via upstream ACP; control plane adapters |
| R-A12 | Render the human able to give one instruction, leave overnight, and return to verified progress | §1 objective | composed by `skein-soak-hardening` (Scenario H) |

## 2. Revised-route requirements (opencode 2 plugin port)

The walking skeleton (P1.2) proved tool/command/RPC/TUI registration on pinned v2.1.3;
these constraints are binding for every port change.

| # | Requirement | Evidence basis | Owning spec |
|---|---|---|---|
| R-P1 | Re-baseline on a pinned upstream release (v2.1.3), unshallowed ancestry, recorded fork/upstream delta | P1.0; audit | `v2-rebaseline` |
| R-P2 | Decide the plugin repo layout (one repo / one repo-per-plugin) as an ADR before any port task | P1.1; `skein2-p1.2-findings.md` trap 4/5 | `plugin-repo-layout` |
| R-P3 | A plugin MUST resolve its entrypoints at package root for path targets, and MUST pin `effect` to the exact version matching the opencode release with an `overrides` entry | P1.2 traps 1–2 | skeleton conventions; enforced in every port change |
| R-P4 | A plugin MUST load visibly or fail loudly (no silent drop on unresolvable entrypoints); CI asserts exactly one `effect` in the tree | P1.2 traps 1, 3 | per-port changes; CI gate in `plugin-repo-layout` |
| R-P5 | Pick one RPC-Schema flavour per plugin (Effect flavour vs Promise flavour) and hold it across the plugin | P1.2 trap 4 decision | each port change's design.md |
| R-P6 | Port `local/` (llama-skein provider, gallery, placement, ctx-fit) behind `rpc.register` and as TUI dialogs, with existing tests re-pointed as the regression gate | P1.3; LOC 10.2k | `port-local-plugins` |
| R-P7 | Port `peer/` with sidecar lifecycle plugin-owned and delegation correlation moved out of process-local memory into durable storage during the port, not after | P1.4; charter §8.4 | `port-peer-plugin` |
| R-P8 | Port `loop/`/`crew/`/`spec-queue/` as a plugin (rewrite expected; hook points gone). Add claim fencing (§8.5), reconcile-before-reassign, and register the worktree implementation via `worktree.transform` | P1.5; charter §8.5 | `port-loop-crew-plugin` |
| R-P9 | Port `beads/` (smallest, last) | P1.6 | `port-beads-plugin` |
| R-P10 | Delete `acp/`, `context/`, `fork/` residue and verify upstream covers charter §6.4 (ACP test list) and §7.6 (lifecycle assertions). Anything that fails is an upstream PR or a documented gap — not a new fork | P1.7; charter §23 | `adopt-upstream-acp-and-service` |
| R-P11 | Ship a `skein` CLI binary driving the plugins' RPC/server API, exposing `status`, `projects`, `agents`, `work ready/running/blocked`, `fleet`, `trace`, `doctor` | P1.8; charter §17 | `skein-cli` |
| R-P12 | Reconcile the 26-change OpenSpec queue (several written against the dead layout): continue / amend / supersede / archive each, before implementing into a tree about to be deleted | P1.9 | `reconcile-openspec-queue-v2` |

## 3. Cross-cutting requirements

| # | Requirement | Charter | Owner |
|---|---|---|---|
| R-C1 | Work items carry zero double-ownership: atomic claims, fencing/generation tokens, reconcile process state before reassignment | §8.5 | P1.5 port + `crew-loop` |
| R-C2 | Every concurrent write change is worktree-isolated, recoverable, and never auto-deleted with unmerged work | §8.6 | P1.5 (`worktree.transform`) + `worktree-lifecycle` practice |
| R-C3 | Policies scope by operator/repo/project/role/action; deny-by-default for privileged actions; approvals persist and bind to their exact action | §14.2–14.4 | `lead-authority` + `standing-publish-authority` |
| R-C4 | Review is independent (different model where available), linked to the exact head SHA, mechanically verified, never self-approved | §15.2 | `review-on-done` |
| R-C5 | All execution is correlated by ID; metrics exposed; diagnosable without the dashboard | §17 | `skein-observability` + `skein-cli` |
| R-C6 | GPU leases live in llama-skein, the single lease authority (lease/renew/release); control plane requests, never claims | §11.5 | `skein-pool` (llama-skein lease extension needed — needs-research R4) |
| R-C7 | The control plane is deployable single-machine or distributed; no Kubernetes/Kafka absent demonstrated need | §9.3, §18 | `skein-control-plane` (ADR 6: SQLite single-host, PostgreSQL distributed) |
| R-C8 | No agent grants itself privileges; peer messages untrusted unless authority verified; permission checked at the actual action boundary | §14.1 | `lead-authority` (grant verify), runtime boundary checks |

## 4. Non-functional anchors

- **Performance:** scheduler tick with no changes does minimal work; no nudge storms;
  bounded retries with reason-aware backoff (charter §9.7, §16.2). Long healthy runs are
  not flagged stalled (§16.3 watchdog evaluates observable progress).
- **Resources:** concurrent-assignment/model/token/cost/exec-duration/nudge caps;
  per-repo and per-role concurrency (§16.4). all configurable.
- **Security:** no public exposure of agent execution APIs by default (§18); multi-host
  identity+transport+authorization defined before distributed use.
- **Success metrics (§21):** zero lost durable assignments, zero conflicting owners,
  zero duplicate integration side-effects, zero unauthorized privileged operations,
  100% independent review coverage of autonomous merges, <1 human intervention per
  routine change, zero unbounded retries. Baseline to be established in
  `skein-soak-hardening` (first full measurement pass).
- **Docs posture:** this document set stays repo-side (`docs/skein-2/`); the loose
  `~/dev/skein2-*.md` companions are the working copies.

## 5. Acceptance anchor

Every requirement terminates in charter §20 scenarios A–H. The scenario → spec map is
`06-work-breakdown.md` §3. Scenario A is re-anchored by the revised plan: driven against
**upstream's** ACP (`acp-external-verification`), not the fork's adapter.
