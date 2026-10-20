## ADDED Requirements

### Requirement: independent cross-repository control plane
The system SHALL provide an independent control plane that orchestrates work across
multiple repositories and project servers, separate from any single project server, and
SHALL NOT run model turns itself.

#### Scenario: cross-repo objective
- **WHEN** an objective spans two repositories with a dependency between them
- **THEN** the control plane assigns the dependent work only after its prerequisite
  completes, across the two registered project servers

#### Scenario: control plane never runs a model
- **WHEN** the control plane has work to execute
- **THEN** it assigns the work to a registered project server or agent and does not
  itself invoke a model

### Requirement: distributed claims with path-scope admission
The control plane SHALL grant work claims through a distributed store using transactional
compare-and-swap with a fencing/ownership-generation token, and SHALL refuse a claim whose
path scope conflicts with a live claim.

#### Scenario: two hosts race for one task
- **WHEN** two hosts request the same task simultaneously
- **THEN** exactly one is granted and the other receives a rejection naming the owner

#### Scenario: scope conflict
- **WHEN** a claim's write scope overlaps a live claim's read or write scope
- **THEN** the claim is refused with the conflicting paths and the live owner named

#### Scenario: stale claim cannot overwrite
- **WHEN** a host presents an expired or lower-generation claim token
- **THEN** its write is rejected and the newer generation is preserved

### Requirement: project-server registration
The control plane SHALL track which repositories are owned by which registered project
servers, and SHALL release in-flight claims when a server stops heartbeating.

#### Scenario: server death releases claims
- **WHEN** a registered project server stops heartbeating
- **THEN** its in-flight claims are released for re-claim, not silently dropped

### Requirement: ready-work from the tracker, not re-derived
The control plane SHALL obtain claimable work (priority and dependencies) from the
specsync-backed tracker and SHALL NOT maintain a parallel priority system.

#### Scenario: missing tracker binding
- **WHEN** a work item has no tracker binding
- **THEN** the control plane applies an explicit safe fallback and does not silently treat
  unchecked work as approved

### Requirement: authoritative GPU leasing
The control plane SHALL request GPU/inference allocations through the llama-skein lease
interface and SHALL NOT double-book a slot that llama-skein has not granted.

#### Scenario: no double booking
- **WHEN** the control plane requests an allocation for a slot llama-skein reports as
  leased
- **THEN** the request is refused or deferred, and no second lease is created
