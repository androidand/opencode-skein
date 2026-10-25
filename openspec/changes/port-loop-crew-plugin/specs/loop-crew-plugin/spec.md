## ADDED Requirements

### Requirement: work claims are fenced and exclusive
Every work-item claim SHALL carry a lease token, an expiry, and a heartbeat, and acquire
atomically (compare-and-swap) with a monotonically increasing ownership generation.

#### Scenario: expired worker is fenced out
- **WHEN** a worker whose lease expired attempts to publish or advance a work item that
  ownership generation moved past it
- **THEN** the write is refused, and the item's true state is never rolled back

### Requirement: reassignment reconciles reality first
Before reassigning an expired claim, the system SHALL check the claimed execution's
actual progress (process liveness, branch/worktree state) — a stale heartbeat alone
never proves the execution stopped.

#### Scenario: healthy long run is not reassigned
- **WHEN** a long assignment still shows observable progress (recent commit, active
  tool call, test progress) with an expired heartbeat
- **THEN** the claim is renewed, not reassigned, and the fixture proves both outcomes
  (recovered vs still-alive)

### Requirement: completion hands off without prompting
When an assignment completes with validated evidence, the workflow engine SHALL unlock
downstream work and assign the next ready item in the same driver turn — no unbounded
prompt loops and no crew-wide stop on assignment end.

#### Scenario: crew keeps rotating (Scenario C engine part)
- **WHEN** a lead + two workers process a repo with multiple ready changes
- **THEN** completion of one item hands off to the next ready one with no further
  human prompts

### Requirement: worktree isolation and preservation
Every concurrent write change SHALL run in a worktree whose name links to the work item
and execution ID; worktrees and branches SHALL be recoverable after crashes, no worktree
that contains uncommitted/unmerged work is deleted automatically, and the transforms
are registered through the plugin's `worktree.transform`.

#### Scenario: abandoned worktree survives
- **WHEN** a worker stops mid-implementation and its worktree holds uncommitted work
- **THEN** the worktree is preserved for recovery and its claim is reconciled, not
  simply dropped
