## ADDED Requirements

### Requirement: an independent AHP host projects managed sessions
The system SHALL expose managed opencode-skein sessions through a conforming Agent Host
Protocol host, reusing ACP as the runtime interface where practical, without modifying the
execution plane's internal chat implementation.

#### Scenario: two clients see one session
- **WHEN** two independent AHP clients subscribe to the same managed session
- **THEN** both observe the same conversation and tool activity, kept synchronized

### Requirement: AHP reconciliation on reconnect
A reconnecting AHP client SHALL receive a correct session state with no duplicated or
missing visible actions.

#### Scenario: disconnect and reconnect
- **WHEN** a client disconnects while execution continues and later reconnects
- **THEN** it receives a snapshot plus the ordered actions it missed, with no duplication
  or gaps in the visible action stream

### Requirement: AHP is a projection, not the workflow authority
The AHP host SHALL be a read projection of runtime session state. Skein work graphs,
approvals, fleet scheduling, dependencies, and policies SHALL remain in the control plane.

#### Scenario: Skein-specific state is not an AHP authority
- **WHEN** a client requests Skein workflow state such as work items, claims, or gates
- **THEN** it is served from the control plane, with AHP exposing only a projection or a
  clearly defined extension

### Requirement: conformance is real, not a label
The host SHALL conform to the AHP specification (channels, `serverSeq` ordering,
snapshots, reconciliation) and SHALL NOT be a custom event WebSocket labeled as AHP.

#### Scenario: conformance validated
- **WHEN** the host is validated against the AHP JSON Schema and driven by the official
  client library
- **THEN** it passes without requiring client-side workarounds
