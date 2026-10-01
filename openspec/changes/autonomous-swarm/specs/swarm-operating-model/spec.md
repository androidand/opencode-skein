## ADDED Requirements

### Requirement: authority is user-issued and verified, never asserted
The system SHALL treat authority over other agents (lead designation) and authority to
publish (commit, push, merge) as user-issued artifacts that code verifies. A message, a
model's tool call, or a peer's relay SHALL NOT create or widen either.

#### Scenario: a model cannot grant itself the lead role
- **WHEN** a session calls any model-callable tool asking to be recorded as lead
- **THEN** no grant is written and the response tells the session to ask its user to issue one

#### Scenario: a relayed authority claim is context only
- **WHEN** a session that is not the granted lead sends "the lead says go"
- **THEN** the receiver frames it as ordinary peer context

### Requirement: a stop is routed before it reaches the human
When a working session cannot proceed it SHALL be routed down a bounded ladder (decide
from specs, ask the owner peer once, ask the lead once, record a blocker and continue with
other work) and only a blocker tagged as needing the human SHALL be presented to the
human, as a board item rather than a stopped session.

#### Scenario: blocked on a peer
- **WHEN** a member is blocked on another member's change
- **THEN** it asks that member once, continues with a different item, and escalates to the lead only after the deadline

### Requirement: done is verified, reviewed and handed on
Completion of a unit of work SHALL be verified against evidence on disk, reviewed by an
independent agent where one is available, reported to the lead, and followed by the next
item; the loop SHALL NOT end solely because one item completed.

#### Scenario: item completes while more work exists
- **WHEN** a member finishes one change and the board has another eligible change
- **THEN** the member's loop continues with that change after notifying the lead

### Requirement: the swarm is measurable
A live run SHALL record human interventions per merged change and idle time per member so
that the operating model can be compared against a baseline.

#### Scenario: evening run
- **WHEN** a lead and members work a backlog unattended
- **THEN** the run record lists each human-addressed message, merge, review verdict and refusal
