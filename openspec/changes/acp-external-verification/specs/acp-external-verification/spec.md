## ADDED Requirements

### Requirement: an independent ACP client drives a real session
The system SHALL be verifiable by an ACP client built on a different official ACP SDK than
the agent's, speaking ACP protocol version 1 over the real wire with no mocked client.

#### Scenario: external client completes Scenario A
- **WHEN** an independent ACP client connects to a real opencode session over
  upstream's native ACP (or the plugin stack standing on it)
- **THEN** it can initialize, create a session, submit a prompt, receive streamed updates,
  respond to a permission request, and cancel an active turn, with every operation
  succeeding

### Requirement: the negotiated protocol version is recorded
The verification SHALL record the negotiated `protocolVersion` and the verifying client's
SDK name and version as evidence.

#### Scenario: evidence captured
- **WHEN** the external-client test runs
- **THEN** it records the negotiated protocol version and the client SDK version and
  stores the request/response transcript as an artifact

### Requirement: fork residue deletion is gated on external verification
Fork-side ACP residue (`acp/`) SHALL NOT be deleted by `adopt-upstream-acp-and-service`
until the independent-client verification of upstream's ACP passes.

#### Scenario: gate holds
- **WHEN** the independent-client test has not passed
- **THEN** the `acp/` residue stays listed and the adoption change's deletion tasks
  remain gated
