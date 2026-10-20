## ADDED Requirements

### Requirement: unified Mission Control dashboard
The system SHALL provide a unified dashboard showing global overview, agent detail, work
graph, agent-communication view, lead chat, resource dashboard, and approvals.

#### Scenario: global overview
- **WHEN** an operator opens the dashboard
- **THEN** they see the active objectives, running agents, blocked work, and pending
  approvals in one view

#### Scenario: work graph
- **WHEN** an operator opens the work graph
- **THEN** they see work items with their dependencies and live claims (owner, read/write
  scope)

### Requirement: reads only platform state
The dashboard SHALL read from the control-plane API and AHP session projections and SHALL
NOT read the workflow database directly.

#### Scenario: degraded control plane
- **WHEN** the control plane is unreachable or stale
- **THEN** the dashboard shows a degraded state and does not fabricate data

### Requirement: lead chat drives the lead session
The dashboard's lead chat SHALL drive the lead session through the stable `swarm_*`
contracts and SHALL NOT grant the lead privileges beyond its durable operator-issued
scope.

#### Scenario: lead cannot self-escalate
- **WHEN** the lead chat requests an action outside the lead's durable scope
- **THEN** the request is refused or escalated for approval, not silently granted

### Requirement: approvals surface
The dashboard SHALL show pending approval requests with scope, target, risk, evidence, and
expiration, and SHALL route approve/deny decisions to the control plane.

#### Scenario: approve a grant
- **WHEN** an operator approves a pending grant in the dashboard
- **THEN** the control plane records the grant with its scope and the requesting agent is
  notified
