## ADDED Requirements

### Requirement: the coordinator never runs a model turn
The coordinator SHALL limit its actions to sending one message, writing one record, raising
one decision, spawning or stopping an agent, and starting or stopping a loop.

#### Scenario: judgement needed
- **WHEN** a condition requires a scope or priority decision
- **THEN** it is routed to the lead and the coordinator takes no other action

### Requirement: coordinator state is durable and lease-held
All coordinator state SHALL live in the database and be held under a lease with heartbeat, so
that a restart or takeover resumes from the ledger.

#### Scenario: holder killed
- **WHEN** the lease holder dies
- **THEN** another instance acquires the lease after the TTL and continues without resending ledgered nudges

### Requirement: nudges are sent once per condition
The coordinator SHALL send at most one nudge per `(slug, agent, gate, reason)` per backoff
window and SHALL stop after the budget and escalate once.

#### Scenario: same condition again
- **WHEN** the same stall condition persists within the window
- **THEN** no second message is sent

#### Scenario: budget exhausted
- **WHEN** three nudges have not changed the evidence
- **THEN** one request goes to the lead and a decide item is created

### Requirement: an idle coordinator is silent
With no live agents and no ready work, the coordinator SHALL write nothing and send nothing.

#### Scenario: empty swarm
- **WHEN** the lease holder ticks with no agents and an empty board
- **THEN** the ledger gains no entries

### Requirement: completion requires evidence
A change SHALL be marked complete only when every required gate has recorded evidence; a
completion token alone SHALL be rejected with the missing evidence listed.

#### Scenario: token without evidence
- **WHEN** an agent reports done with unchecked tasks
- **THEN** completion is rejected and the missing gates are listed

### Requirement: the coordinator acts under the lead grant
The coordinator SHALL act only while a valid lead grant exists and only within the scopes the
grant gives its delegate record.

#### Scenario: no lead
- **WHEN** no valid grant exists
- **THEN** nudging pauses and a no-lead decision is recorded
