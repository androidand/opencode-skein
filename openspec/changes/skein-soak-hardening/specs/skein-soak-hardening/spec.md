## ADDED Requirements

### Requirement: sustained operation without work loss
The system SHALL survive a sustained soak under realistic load with injected failures
without losing work or double-executing a non-idempotent operation.

#### Scenario: server killed mid-soak
- **WHEN** the soak kills a server mid-operation and restarts it
- **THEN** the work resumes from the durable record and actual repository state, and no
  non-idempotent operation is run twice

#### Scenario: no orphaned claims
- **WHEN** the soak runs to completion
- **THEN** no claim is left orphaned and no lease is leaked

### Requirement: distributed correctness
The system SHALL maintain correct ordering and exactly-one-winner claim semantics across
multiple hosts and repositories.

#### Scenario: cross-repo dependency under load
- **WHEN** the distributed soak runs a cross-repo objective with dependencies
- **THEN** the dependent work runs only after its prerequisite and no task is claimed by
  two hosts

### Requirement: every soak defect has a regression test
Each defect the soak reveals SHALL be fixed with a regression test that fails without the
fix.

#### Scenario: defect fixed
- **WHEN** a soak reveals a defect and it is fixed
- **THEN** a regression test exists that fails on the pre-fix code and passes on the fix
