## ADDED Requirements

### Requirement: planning claims are anchored to an unshallowed, pinned target
Every ancestry or delta claim made by Phase 1a work SHALL cite the pinned upstream
release tag from a repo with unshallowed history, and the delta map SHALL be generated
by command output, never hand-copied.

#### Scenario: delta map is reproducible
- **WHEN** the delta-map generation commands are re-run against the pinned tag
- **THEN** the output matches the committed map (module whitespace), proving no claim
  rests on stale or summarized data

#### Scenario: shallow repo fails loudly
- **WHEN** an ancestry assertion is attempted in a still-shallow clone
- **THEN** the check aborts with a clear error instead of passing on truncated history

### Requirement: the fork's mutable state is inventoried before adoption
The fork-specific config and data locations SHALL be recorded in the current-state doc
before anything that could drop or migrate them (`adopt-upstream-acp-and-service`),
so no session or state can be silently lost at the fork boundary.

#### Scenario: migration decision has inputs
- **WHEN** `adopt-upstream-acp-and-service` makes the migrate-or-fresh-split decision
- **THEN** the inventory of fork-specific mutable paths exists and is cited
