## ADDED Requirements

### Requirement: no active change is unclassified against the runtime route
Every active OpenSpec change SHALL carry a verdict (continue / amend / supersede /
archive) resolved against the opencode-2 plugin route, citing the classification of
record in this change.

#### Scenario: the queue is readable as truth
- **WHEN** an agent or human opens any active change to act on it
- **THEN** its proposal states its verdict and, where superseded, the carrying change
  by slug — nothing has to be re-derived from fork-era assumptions

### Requirement: superseded requirements are carried, not dropped
A supersede verdict SHALL name the owning change whose spec carries the requirements;
verdicts that would drop a still-wanted behavior are misclassifications, not saves.

#### Scenario: carried requirements exist at the destination
- **WHEN** `crew-loop`, `loop-done-handoff`, `model-gallery-ui`, or
  `per-model-placement-controls` is superseded by a port change
- **THEN** that port change's spec/tasks demonstrably carry the superseded
  requirements (cross-cited both ways)

### Requirement: pending verifications hold their dependents
Rows whose scope depends on an unverified v2 behavior SHALL record that dependency
in-file (e.g. `opencode service` prompt handling) rather than resolving it
optimistically.

#### Scenario: a dependent change waits
- **WHEN** an agent reaches a hold-row's implementation while the verification is open
- **THEN** the in-file dependency stops it, with the verification evidence as the
  unblock condition
