# Skein 2.0 — Architecture Decisions (ADRs)

The twelve ADRs required by charter §22. Each follows: Context, Alternatives, Decision,
Rationale, Consequences, Migration impact, Reversal strategy. Open implementation details
are marked **needs-research** (IDs refer to `06-work-breakdown.md` §8) rather than guessed.

Repo: `androidand/opencode-skein`.

---

## ADR 1 — Control plane boundary

**Context.** `swarm-coordinator` (#104) places coordination *inside* the opencode-skein
project server. Charter §9.1 explicitly prefers project-local supervision in opencode-skein
**and** cross-repository orchestration in an *independent* Skein control plane, to keep the
option of driving Claude Code and other runtimes without a permanent OpenCode dependency.

**Alternatives.**
- A. All coordination in the project server (the `swarm-coordinator` proposal).
- B. Independent control plane for cross-repo; project-local conductor for in-repo.
- C. A single global coordinator that also owns per-project state.

**Decision.** B. `swarm-coordinator` remains the **project-local** conductor (mechanical
tick, no LLM, DB-backed lease). A new `skein-control-plane` owns **cross-repo**
orchestration and *reuses* the conductor's primitives (gates, rules, nudge, claims) rather
than reimplementing them.

**Rationale.** Preserves runtime-agnosticism, avoids two competing coordinators, and keeps
the in-repo hot path local (low latency, no network dependency for single-repo work).

**Consequences.** Two coordination scopes with a named seam: project servers register with
the control plane; the control plane never runs a model turn. Cross-repo work needs the
control plane; single-repo work does not.

**Migration impact.** `swarm-coordinator` unchanged in scope; `skein-control-plane` is new.
The conductor's primitives must be extractable (shared types/ledger) — a refactor, not a
rewrite.

**Reversal strategy.** The boundary is a logical seam. If cross-repo needs never
materialize, the control plane can run as a thin single process; if per-project
coordination proves too heavy, it can be lifted. Neither direction forces a rewrite.

**needs-research.** R6 (which Go `skein` packages to reuse), R7 (PostgreSQL vs SQLite for
the control plane).

---

## ADR 2 — Project server ownership

**Context.** Today every `opencode` launch starts its own in-process server; the loop
registry is an in-memory `Ref`; a loop dies when its TUI closes. This is the root of the
"one terminal per agent" cost and of lost state on crash.

**Alternatives.**
- A. One heavyweight server process per agent.
- B. One persistent server per repository (git common dir), owning many sessions/agents.
- C. A machine-wide singleton server.

**Decision.** B. One server per repository, discovered via a registry record; it owns
runtime sessions, project-local agents, durable loops, worktree contexts, and local
recovery. Multiple clients (TUI/CLI/headless) attach.

**Rationale.** The repo is the natural unit of shared state and worktree isolation; it
matches the existing `x-opencode-directory` per-instance model and `opencode attach`.

**Consequences.** A server crash affects one repo's agents (mitigated by durable loops +
respawn + `--standalone` escape hatch). Per-instance code must be audited for
process-vs-instance scoping.

**Migration impact.** `project-server` change (registry, auto-attach, durable loops,
`DurableAgentExecution` record). Behind `experimental.project_server`.

**Reversal strategy.** `--standalone` restores today's per-process behavior at any time.

---

## ADR 3 — ACP adapter strategy

**Context.** The fork implemented ACP on the deprecated interface-based API. It has been
migrated to the fluent SDK 1.8.0 (`skein2/acp-sdk-1.8`, `01-acp-migration.md`), but the
compatibility tests mock the client side.

**Alternatives.**
- A. Keep the deprecated `AgentSideConnection` API.
- B. Migrate to the fluent API and verify only with unit tests.
- C. Migrate to the fluent API and verify with an independent external client.

**Decision.** C. Keep the fluent API; prove it with a real external ACP client built on a
*different* official SDK (Python or Rust, protocol v1) — `acp-external-verification`
(#118). Remove the deprecated compatibility switch only after that passes.

**Rationale.** Charter §6.4 requires "compatibility with at least one independent ACP
client" and validation "against the actual external protocol." A shared-SDK unit test
cannot catch a wire mismatch.

**Consequences.** A verification harness + CI job. No business-logic changes. ACP v2 is
explicitly out of scope (charter §6.4).

**Migration impact.** Additive test harness; one follow-up commit removes the compat switch.

**Reversal strategy.** The compat switch stays until the gate passes, so the old path is
always available during migration.

---

## ADR 4 — AHP host strategy

**Context.** Charter §12 requires a standardized, synchronized, multi-client interface to
managed sessions. AHP (microsoft/agent-host-protocol) is the standard: channel-routed,
`serverSeq`-ordered, write-ahead reconciliation. It is a *presentation* layer, not the
workflow database (charter §4.4).

**Alternatives.**
- A. Reuse `ahp-acp-gateway` (a conforming AHP host that runs ACP agents).
- B. Build on `@ahpd/sdk` (plugin host).
- C. Build a thin host on the `@microsoft/agent-host-protocol` TS client lib.

**Decision.** An **independent AHP host** that is a *read projection* of runtime session
state, reusing ACP as the runtime interface, read-only first (one session, two clients),
then interactive. The host is never the workflow authority.

**Rationale.** Conformance is required (charter §12.3 forbids labeling a custom WebSocket
as AHP). A read projection keeps internal event sourcing separate from AHP state
(charter §12.4) and avoids competing mutable authorities.

**Consequences.** A new small service + ACP→AHP projection adapter + two test clients. No
execution-plane changes. Skein-specific state (work items, claims, gates) stays in the
control plane, exposed via AHP extensions only where suitable.

**Migration impact.** Additive; `ahp-host` change (#119). Feeds `mission-control`.

**Reversal strategy.** The host is a separate process; removing it leaves the execution
plane and ACP untouched.

**needs-research.** R8 (which of A/B/C to build on).

---

## ADR 5 — A2A strategy

**Context.** Agent-to-agent messaging exists (peer registry, message envelope, Claude Code
sidecar, task delegation). `peer/delegate.ts` keeps its pending-task reply registry in
process-local memory, which cannot be the sole authority for durable delegation (charter
§8.4).

**Alternatives.**
- A. Replace A2A with a new transport.
- B. Keep A2A and add durability (persistent correlation, idempotent outcomes).
- C. Keep A2A as-is.

**Decision.** B. Keep the existing peer/A2A transport and framing; add durable message
identifiers, task correlation IDs, delivery acknowledgments, deduplication, deadlines,
retries, and exactly-one-committed-outcome semantics — `peer-conversation-reliability`.

**Rationale.** Charter §23: "Do not replace working peer communication without a concrete
benefit." The gap is durability, not the transport.

**Consequences.** A persistent correlation store; at-least-once delivery with idempotent
processing (no exactly-once network promise).

**Migration impact.** `peer-conversation-reliability` change; `peer/delegate.ts` registry
moves to durable storage.

**Reversal strategy.** The envelope and framing are unchanged, so the old in-memory path
can be re-enabled per-deployment if needed.

---

## ADR 6 — Durability

**Context.** Coordination and execution state is currently in-memory and lost on crash.
Charter §7.5 and §9.4 require explicit storage ownership and a single source of truth per
concern.

**Alternatives.**
- A. One database for everything.
- B. SQLite for project-local runtime state; PostgreSQL for the distributed control plane.
- C. No new database; extend existing OpenCode storage only.

**Decision.** B, with a strict rule: do not introduce both for the *same* concern.
Project-local runtime data (sessions, loops, `DurableAgentExecution`) uses the existing
project store (SQLite is appropriate for single-host). Global orchestration state (claims,
workflows, cross-repo assignments) uses a shared durable store (PostgreSQL is appropriate
for the distributed control plane). Claims use transactional compare-and-swap with a
fencing/ownership-generation token (charter §8.5).

**Rationale.** Matches the two-plane boundary (ADR 1); avoids a single-writer bottleneck
for global state while keeping the local hot path cheap.

**Consequences.** Transaction boundaries and single-writer assumptions must be documented
per store. A reconciliation loop handles missed events and expired claims.

**Migration impact.** `project-server` (local store) + `skein-control-plane` (global
store).

**Reversal strategy.** The stores are behind the plane boundary; a single-host deployment
can run the control plane over the same local store if distribution is not needed.

**needs-research.** R7 (confirm PostgreSQL vs SQLite for the control plane at target
scale).

---

## ADR 7 — GPU scheduling

**Context.** The environment has AMD GPU hosts, Macs, and llama-skein inference servers.
Charter §11.5 requires authoritative leasing at the correct boundary and forbids two
systems claiming authority over the same GPU.

**Alternatives.**
- A. opencode-skein tracks its own slot reservations.
- B. llama-skein is the authoritative lease holder; the control plane requests allocations.
- C. A new central resource broker.

**Decision.** B. llama-skein owns inference-slot leases (confirmed: `POST/DELETE
/api/slots/lease`, in-memory, TTL — R4). The control plane's resource broker requests
allocations through that interface and does not double-book.

**Rationale.** llama-skein already knows loaded models, slots, and KV-cache constraints;
a second authority would double-book (charter §11.5, §23).

**Consequences.** Scheduling policy (model suitability, context, warm reuse, fairness)
lives in the control plane's broker; the *lease* lives in llama-skein.

**Migration impact.** `skein-pool` (#88) lease integration; placement corrections
(charter §11.4).

**Reversal strategy.** The broker is a policy layer; if llama-skein leasing changes, only
the adapter changes.

**needs-research.** llama-skein leases have no renewal or list endpoint (R4); the
`skein-pool` lease task must add renewal/list to llama-skein or model renewal
client-side — an owner decision, not guessed.

---

## ADR 8 — Work-source authority

**Context.** Work is defined in OpenSpec files, prioritized in the specsync-backed tracker,
and executed by the control plane. Charter §10.2 and §23 forbid a parallel priority system
and reimplementing specsync's tracker mapping.

**Alternatives.**
- A. The control plane owns its own priority/dependency store.
- B. OpenSpec = definitions, specsync tracker = priority/dependencies, control plane =
  execution claims.

**Decision.** B. Single source of truth per concern (charter §9.4): OpenSpec files are the
definitions; the specsync-backed tracker is the authority for priority and dependencies;
the control plane is the authority for *execution claims* only. The control plane asks for
claimable work; it does not re-derive priority.

**Rationale.** Avoids a parallel source of truth and keeps the existing specsync
investment authoritative.

**Consequences.** A machine-readable ready-work contract is needed (charter §10.2).
Missing tracker bindings need an explicit safe fallback; unchecked tasks are not silently
treated as approved.

**Migration impact.** `auto-across-repos` (#20) ready-work integration.

**Reversal strategy.** The claim store is separate from the priority store, so either can
change independently.

**needs-research.** R5 (specsync is write-mostly today; a ready-work/claimable query is
needed — new specsync endpoint or control-plane-side tracker query).

---

## ADR 9 — Security

**Context.** Autonomous operation must be explicitly authorized (charter §14). Peer
messages are untrusted; permissions must be checked at the action boundary.

**Alternatives.**
- A. Role-based implicit privileges.
- B. Deny-by-default action policies with durable operator-issued grants.

**Decision.** B. Deny-by-default for privileged operations; explicit denials override
broader grants. Authority comes from durable, operator-issued grants (`lead-authority`
#98, `standing-publish-authority` #99), not from a message claiming "I am the lead."
Permissions are enforced at the runtime action boundary. Approval requests persist with
scope, target, risk, evidence, and expiration (charter §14.4).

**Rationale.** Prevents permission laundering and self-granted privilege (charter §14.1,
§23).

**Consequences.** A policy store and an approval lifecycle; the lead is a managed session
with delegated scope, not a special process.

**Migration impact.** `lead-authority`, `standing-publish-authority`,
`escalate-before-idle` (#100).

**Reversal strategy.** Policies are data; tightening or widening a grant is a policy edit,
not a code change.

---

## ADR 10 — Frontend

**Context.** Charter §13 requires a unified Mission Control dashboard (global overview,
agent detail, work graph, agent-communication view, lead chat, resource dashboard,
approvals).

**Alternatives.**
- A. Extend the existing OpenCode web UI.
- B. A small independent control-plane dashboard.

**Decision.** **Open — to be decided in `mission-control`.** Leaning B (a small
independent dashboard) if deep OpenCode-UI integration would create excessive upstream
maintenance; A if the OpenCode UI already exposes the needed session surfaces. The choice
is documented with the tradeoff (charter §13.7).

**Rationale.** The dashboard must read from actual platform state (control plane + AHP
projections), which the OpenCode UI may not expose.

**Consequences.** Whichever is chosen reuses shared UI components/SDKs; the lead-chat tools
(`swarm_*`) are stable contracts, optionally exposed via MCP.

**Migration impact.** `mission-control` change.

**Reversal strategy.** The dashboard is a read surface over stable APIs; swapping the
frontend does not change the control plane.

**needs-research.** R9 (OpenCode web UI capabilities vs independent dashboard).

---

## ADR 11 — Observability

**Context.** Charter §17 requires structured telemetry, correlation across operations,
metrics, and diagnostic CLI commands. The system must be diagnosable without the dashboard.

**Alternatives.**
- A. Ad-hoc logging only.
- B. OpenTelemetry with explicit correlation identifiers + a diagnostic CLI.

**Decision.** B. Adopt OpenTelemetry where suitable. Correlate every operation through
`objective_id`, `work_item_id`, `execution_id`, `agent_id`, `session_id`, `turn_id`,
`model_request_id`, `resource_lease_id`, `trace_id`. Expose the charter §17 metrics and
diagnostic commands (`skein status|projects|agents|work|fleet|trace|doctor`), reconciled
with existing CLI conventions.

**Rationale.** Correlation IDs make a work item's full history reconstructable; the CLI
keeps the system operable headless.

**Consequences.** An OTel exporter and a correlation-ID propagation convention across the
planes; the AHP `ahp-otlp:` telemetry channel is a natural fit for host telemetry.

**Migration impact.** `skein-observability` change (cross-cutting).

**Reversal strategy.** Telemetry is additive; disabling the exporter restores prior
behavior.

**needs-research.** R10 (OTel SDK, exporter, and correlation-ID propagation mechanism).

---

## ADR 12 — Deployment

**Context.** The target environment spans macOS dev machines, a Proxmox homelab, Linux
hosts/LXCs, local GPU servers, and llama-skein (charter §18).

**Alternatives.**
- A. Distributed-only (Kubernetes/Kafka).
- B. Three explicit modes: local developer, single-host persistent, distributed homelab.

**Decision.** B. Support local developer mode, single-host persistent mode, and
distributed homelab mode. The control plane is deployable as a single service first; no
Kubernetes/Kafka without a demonstrable requirement (charter §9.3, §23). Agent execution
APIs are not exposed publicly by default; multi-host operation defines explicit identity,
transport, and authorization. Tengil/Proxmox integration is optional — the control plane
works without it.

**Rationale.** Matches the actual environment and the "no unnecessary infrastructure"
constraint.

**Consequences.** Service discovery and authentication are explicit; the single-host mode
is the default development and first production target.

**Migration impact.** `skein-control-plane` (deployment) + `skein-soak-hardening`
(distributed soak).

**Reversal strategy.** Modes are deployment configurations, not code forks; a deployment
can move between modes.
