## ADDED Requirements

### Requirement: correlation across operations
The system SHALL correlate every operation through a stable set of identifiers
(objective, work item, execution, agent, session, turn, model request, resource lease,
trace) so that a work item's full history is reconstructable from its correlation IDs
alone.

#### Scenario: reconstruct a work item
- **WHEN** an operator runs a trace for one work item
- **THEN** the system returns the full history of its executions, agents, sessions, turns,
  model requests, and leases

### Requirement: structured telemetry
The system SHALL emit structured telemetry (traces and metrics) for throughput,
efficiency, claim latency, lease usage, and error rates.

#### Scenario: metrics exposed
- **WHEN** the system is running
- **THEN** the charter §17 metrics are exported and queryable

### Requirement: headless diagnostics
The system SHALL be diagnosable through a diagnostic CLI without the dashboard.

#### Scenario: doctor without a dashboard
- **WHEN** an operator runs the diagnostic command on a headless host
- **THEN** the system reports control-plane, project-server, agent, and lease health from
  the CLI
