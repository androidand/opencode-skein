## ADDED Requirements

### Requirement: completion of an item does not end the run
When a member completes an item and more eligible work exists, the loop SHALL continue with
the next item after reporting, and SHALL NOT finalize.

#### Scenario: next change waiting
- **WHEN** change A completes and change B is eligible
- **THEN** the loop continues with B and the lead receives one completion notice for A

### Requirement: an empty board is idle-watch, not completed
When no eligible work remains, the loop SHALL enter a non-terminal watching state with
backoff, SHALL send nothing, and SHALL wake on a new message, board change or lead
directive, unless the run was started with `--once`.

#### Scenario: board empties
- **WHEN** the queue drains
- **THEN** the loop status is idle-watch, not completed

#### Scenario: new change appears
- **WHEN** a new eligible change is added while idle-watching
- **THEN** the loop resumes with it

### Requirement: a completion token needs evidence for spec-backed work
When a change slug is attached, a completion token SHALL be accepted only if its tasks are
checked and its gates pass; otherwise the loop SHALL continue and say what is missing.

#### Scenario: token with unchecked tasks
- **WHEN** the model emits the token and the change has unchecked tasks
- **THEN** the loop continues with a brief naming the unchecked tasks

### Requirement: one completion notice per completion
The system SHALL send exactly one completion notice per completed item, carrying slug,
branch, head SHA and gate results.

#### Scenario: duplicate completion event
- **WHEN** the same completion is observed twice
- **THEN** one notice is sent

### Requirement: a lead delegation starts verified work
A slug-bearing delegation from the granted lead SHALL start a queue-mode loop for that slug,
acknowledge immediately, and notify on completion. Delegation from any other sender SHALL be
unchanged.

#### Scenario: lead delegates a change
- **WHEN** the lead delegates change X to an idle member
- **THEN** the member acknowledges, works X under verified completion, and sends one notice at the end
