## ADDED Requirements

### Requirement: done triggers an independent review of the exact commit range
When a session completes work that produced commits or a diff, the system SHALL request a
review of `base..head` from an agent other than the author before the work counts as done.

#### Scenario: loop completes a change
- **WHEN** a member's loop completes a change with new commits
- **THEN** a reviewer is asked to review that range at the head SHA

#### Scenario: already approved
- **WHEN** the head SHA already has an `LGTM` recorded
- **THEN** no new review is requested

### Requirement: the reviewer differs from the author where possible
Reviewer selection SHALL prefer a different harness, then a different model family, then a
different model, and SHALL mark the review `same-model` when none is available.

#### Scenario: only the author's model is available
- **WHEN** no other model or harness is reachable
- **THEN** the review proceeds and is recorded as same-model

### Requirement: the verdict is recorded against the head SHA
A review SHALL write `{headSHA, reviewer, verdict, findings, round}` to `.skein/review.json`.
A reply without an `LGTM` or `NEEDS_WORK` token SHALL be recorded as no verdict.

#### Scenario: no token
- **WHEN** the reviewer replies "looks good" with no token
- **THEN** the record has no verdict and the gate does not pass

### Requirement: a stale review does not approve new commits
An approval SHALL apply only to the SHA it recorded.

#### Scenario: commits after review
- **WHEN** a commit is added after an `LGTM`
- **THEN** the merge requirement for review is unmet until the new head is reviewed

### Requirement: review rounds are bounded
`NEEDS_WORK` SHALL reopen implementation with the findings, at most three times, after which
the item SHALL be escalated through the escalation ladder.

#### Scenario: third failed round
- **WHEN** the third review returns `NEEDS_WORK`
- **THEN** the lead is asked once and the member continues other work

### Requirement: the review hook does not recurse
A review session's own completion SHALL NOT trigger another review.

#### Scenario: reviewer finishes
- **WHEN** the reviewer's session stops
- **THEN** no review of the review is requested
