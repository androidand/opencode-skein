## ADDED Requirements

### Requirement: a hosted subagent SHALL run in a fresh session, not in the host's

A peer that accepts borrowed work SHALL create a new child session for it, carrying the host's
provider and model and no prior history. The host's own session SHALL NOT receive the task text
as a prompt.

#### Scenario: a peer hosts work for another session
- **WHEN** a session accepts a hosted-subagent request
- **THEN** the task runs in a new child session, and the host's own transcript records only that it hosted a task

#### Scenario: the borrowed work finishes
- **WHEN** a hosted subagent completes
- **THEN** its result is returned to the caller through the correlation header and the child session is not left behind as a peer

### Requirement: a hosted subagent SHALL run under the host's permissions

Borrowed work SHALL be subject to the permission rules of the session hosting it, never those of
the caller.

#### Scenario: a caller delegates work it could not perform itself
- **WHEN** a caller requests work its own permissions would refuse
- **THEN** the host applies its own rules, and the caller gains no reach it did not have

### Requirement: a peer MAY refuse to host, and refusal SHALL be a normal outcome

Being idle SHALL NOT imply consent. A refusal SHALL be returned promptly and SHALL cause the
caller's placement to consider the next candidate rather than surfacing an error.

#### Scenario: an idle peer declines
- **WHEN** a peer refuses a hosted-subagent request
- **THEN** placement selects another candidate and the model sees no failure

### Requirement: placement SHALL prefer capacity that is unowned and already warm

Ranking SHALL account for whether a live session is bound to a host and whether the needed model
is resident, preferring an unowned host with the model loaded and ranking last a host whose bound
session serves a different model.

#### Scenario: a host has a free slot but a session is bound to it
- **WHEN** one candidate host has a free slot with a session bound to it serving a different model, and another is unowned with the model resident
- **THEN** the unowned host is chosen

#### Scenario: a capacity probe fails
- **WHEN** a host's probe does not answer
- **THEN** it ranks below any candidate that did answer, and the decision does not fall through to inheriting the parent's model without a recorded reason

### Requirement: every placement decision SHALL be explainable after the fact

The chosen option and the rejected candidates with their scores SHALL be recorded, so whether
agents use peer capacity is answerable from evidence.

#### Scenario: an operator asks why a subagent ran locally
- **WHEN** placement runs for a subagent
- **THEN** the log names the chosen target and why each alternative lost
