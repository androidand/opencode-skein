## ADDED Requirements

### Requirement: an opencode sender is attributed only after it confirms the message
The system SHALL attribute an inbound peer message to an opencode session only when that session's own
sidecar confirms it sent that message id to this receiver.

#### Scenario: forged sender
- **WHEN** a message claims to be from another session that never sent it
- **THEN** it is delivered unattributed and grants no lead authority

#### Scenario: no answer
- **WHEN** the claimed sender does not answer in time
- **THEN** the message is delivered with the sender marked unverified, not dropped
