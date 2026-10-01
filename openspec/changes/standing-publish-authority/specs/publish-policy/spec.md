## ADDED Requirements

### Requirement: a valid policy is the durable explicit instruction to publish
The system SHALL treat a valid publish policy as the user's explicit instruction for the actions it lists.
Valid means: valid at load and in agreement with the forge's reported visibility. The grant covers
commit, push and merge, within the patterns the policy lists.

#### Scenario: granted push
- **WHEN** a policy allows push to `origin` for `loop/*` and a session pushes `loop/foo`
- **THEN** the push is permitted

#### Scenario: ungranted branch
- **WHEN** the session pushes a branch matching no listed pattern
- **THEN** the push is denied

### Requirement: the policy is validated and fails closed
The policy SHALL be validated against a closed schema when parsed. Any invalid or
inconsistent state, including visibility disagreeing with the forge, SHALL disable all
publishing grants for that repository and log the reason.

#### Scenario: wrong-typed value
- **WHEN** a key that must be a mapping holds a scalar
- **THEN** all grants are off and sessions behave as without a policy

#### Scenario: visibility mismatch
- **WHEN** the file says private and the forge says public
- **THEN** all grants are off

### Requirement: a non-overridable never-list
The system SHALL keep a fixed set of actions denied under any policy.
The set is force-push, shared-ref history rewrite, remote changes, tags and releases, visibility
changes, credential configuration and deploy.

#### Scenario: force push under a grant
- **WHEN** a policy allows push and the session runs a force push
- **THEN** it is denied

### Requirement: merge requires evidence
A merge SHALL require, per the policy, passing gates, a recorded review verdict for the exact
head SHA, and green CI, and SHALL stop for a human when the merge base is empty.

#### Scenario: stale review
- **WHEN** commits were added after the recorded review verdict
- **THEN** the merge is refused until the head SHA is reviewed

### Requirement: public repositories are scanned before push
For a repository whose visibility is public, the outgoing diff SHALL be scanned for private
network addresses, home paths, tokens and listed hostnames, and a hit SHALL block the push.

#### Scenario: private address in diff
- **WHEN** the diff contains an RFC1918 address
- **THEN** the push is blocked and the finding is reported
