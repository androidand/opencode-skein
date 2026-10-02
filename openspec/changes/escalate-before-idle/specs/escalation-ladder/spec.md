## ADDED Requirements

### Requirement: blockers follow a bounded ladder
A member that cannot proceed SHALL, in order: decide from the specs; ask the owning peer once
with a deadline while continuing other work; ask the lead once after the deadline; record a
blocker and continue with other work. Only a blocker tagged as needing the human SHALL be
presented to the human.

#### Scenario: blocked on a peer
- **WHEN** a member is blocked on a peer's change
- **THEN** it sends one request, switches to another item, and does not message the human

#### Scenario: deadline passes
- **WHEN** the peer has not replied by the deadline
- **THEN** the member sends one request to the lead and continues other work

### Requirement: each rung sends at most once
The system SHALL send at most one message per `(item, rung)` and SHALL NOT send "are you
done" follow-ups.

#### Scenario: repeated condition
- **WHEN** the same blocked condition is evaluated again
- **THEN** no second message is sent

### Requirement: a stop that asks the human is answered, not accepted
The loop SHALL respond with a bounded ladder nudge instead of ending the run when an iteration
ends with no tool calls and its text asks the user or waits on a peer. After the budget it SHALL
record a blocker and continue the queue.

#### Scenario: asked the user a question
- **WHEN** the turn ends "should I proceed with option A or B?" and the specs favour A
- **THEN** the next prompt tells the model to decide from the specs and continue

### Requirement: blockers are structured and validated
Blocker records SHALL carry `needs`, `waiting-on`, `asked-at`, `deadline` and `rung` and SHALL
be validated against a closed schema when read.

#### Scenario: malformed blocker
- **WHEN** `needs` holds a value other than team or human
- **THEN** the record is rejected as invalid and treated as `needs: team` with a logged reason

### Requirement: waiting is event-driven
A blocked member SHALL be woken by the peer's reply or idle signal or by a persisted deadline,
and SHALL NOT poll.

#### Scenario: peer replies
- **WHEN** the awaited peer replies
- **THEN** the blocked item resumes on the next iteration
