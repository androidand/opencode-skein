# Tasks: mission-control

## Phase 1: Dashboard shell

- [ ] 1.1 New web package (independent of the Astro docs site) with a data layer that
      reads only the control-plane API and AHP session projections.
- [ ] 1.2 Global overview view: objectives, active agents, blocked work, pending
      approvals.
- [ ] 1.3 Degraded state: an unreachable or stale control plane is shown as degraded,
      never fabricated.

## Phase 2: Core views

- [ ] 2.1 Agent detail: session, turns, resource leases, execution record.
- [ ] 2.2 Work graph: dependencies + live claims (read/write scopes, owners).
- [ ] 2.3 Agent-communication view: peer/A2A messages with correlation IDs.
- [ ] 2.4 Resource dashboard: GPU/inference leases from llama-skein.

## Phase 3: Lead chat + approvals

- [ ] 3.1 Lead chat: drive the lead session through the stable `swarm_*` contracts
      (optionally via MCP).
- [ ] 3.2 Approvals view: pending grants with scope, target, risk, evidence, expiration
      (charter §14.4); approve/deny actions call the control plane.

## Phase 4: Reuse + polish

- [ ] 4.1 Reuse shared UI components/SDKs; no parallel component library.
- [ ] 4.2 Metrics views fed by `skein-observability`.
