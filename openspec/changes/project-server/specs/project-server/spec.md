## ADDED Requirements

### Requirement: one server per repository, discovered by registry
The system SHALL run at most one project server per repository, identified by the git common
directory, and SHALL let clients discover it through a registry record validated by process
liveness, start-time match and a health check.

#### Scenario: second launch attaches
- **WHEN** a healthy server record exists for the repository and a second `opencode` is launched in any of its worktrees
- **THEN** the second instance attaches to the existing server and does not start another

#### Scenario: stale record
- **WHEN** the record's process is dead or its start time does not match
- **THEN** the record is removed and a new server is started

### Requirement: agents outlive their clients
An agent SHALL be owned by the server. Closing a TUI or CLI client SHALL NOT stop the agent's
session or loop.

#### Scenario: detach
- **WHEN** the only client attached to a running agent exits
- **THEN** the agent's loop continues and a later client can attach and see its history

### Requirement: headless agents
The system SHALL allow an agent to be spawned in a worktree with no client attached, and a
human SHALL be able to attach a TUI to any agent.

#### Scenario: spawn and attach
- **WHEN** an agent is spawned for change X headlessly
- **THEN** it appears in the roster as headless and `agent attach` opens its session

### Requirement: loops survive a server restart
Loop state SHALL be durable, and a restarted server SHALL re-adopt running loops without
duplicating an iteration.

#### Scenario: server killed mid-iteration
- **WHEN** the server process is killed during an iteration and restarted
- **THEN** the loop resumes with a fresh iteration and the abandoned turn is not counted as completed

### Requirement: the server is secured
The auto-started server SHALL bind only to loopback or a unix socket and SHALL require a
generated password stored with owner-only permissions.

#### Scenario: non-loopback bind requested
- **WHEN** a non-loopback address is requested without an explicit flag
- **THEN** startup is refused

### Requirement: in-server messaging uses attributed identity
For sessions in the same server, delivery SHALL identify the sender by the server's own
attribution, with the same envelope and framing as socket delivery.

#### Scenario: same-server message
- **WHEN** one agent messages another in the same server
- **THEN** it is delivered without a socket and framed identically to a sidecar delivery
