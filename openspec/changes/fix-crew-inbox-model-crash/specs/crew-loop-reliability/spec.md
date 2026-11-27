## ADDED Requirements

### Requirement: Peer messages do not stop a loop
The loop SHALL store an inbound peer message with the agent and model of the
session's latest user message.

#### Scenario: message arrives mid-turn
- **WHEN** a peer message arrives while a loop turn is running
- **THEN** the next step runs with the same model and the loop stays running

### Requirement: Claims follow the run that holds them
The queue run SHALL release its claim when it ends, and a claim whose heartbeat
is stale SHALL NOT block another run.

#### Scenario: cancelled mid-change
- **WHEN** a queue run is cancelled while holding a claim
- **THEN** the claim is released

#### Scenario: holder process disappeared
- **WHEN** a claim's heartbeat is older than the stale limit
- **THEN** another run can claim the change

### Requirement: A dead loop says why
The loop SHALL record the cause in its report when its driver dies.

#### Scenario: driver defect
- **WHEN** the loop driver dies with an unexpected error
- **THEN** the loop status is `error` and the report names the cause
