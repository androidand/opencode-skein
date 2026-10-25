## ADDED Requirements

### Requirement: delegation survives process death
Peer task delegation SHALL be backed by durable correlation records (task ID,
correlation ID, deadline, attempts, committed outcome) instead of process-local memory;
a dead process must not orphan an in-flight task reply, and a restarted session must
see the committed outcome.

#### Scenario: crash mid-round-trip
- **WHEN** a delegated task's delegate crashes after receiving but before committing
  an outcome
- **THEN** the record survives with its attempt state, the retry policy applies, and a
  later outcome commits exactly once

### Requirement: at-least-once delivery, one committed outcome
Delegated task delivery MAY retry (at-least-once). Processing SHALL be idempotent so a
duplicate delivery cannot double-commit an outcome for the same work item.

#### Scenario: duplicate delivery deduplicated
- **WHEN** the same delegation is delivered to a peer twice (replay or retry)
- **THEN** the outcome ledger holds one committed outcome, and the peer's visible
  conversation flow is not duplicated

### Requirement: the sidecar lifecycle is plugin-owned and orphan-free
The Claude Code sidecar SHALL be managed by the plugin (spawn, cleanup, reload) and
MUST NOT leak orphan processes across plugin loads, preserving the
`sidecar-orphan-cleanup` guarantees.

#### Scenario: plugin reload does not orphan the sidecar
- **WHEN** `skein-peer` reloads while an old sidecar is running
- **THEN** the old process is reclaimed (or its absence proven), and no zombie remains
