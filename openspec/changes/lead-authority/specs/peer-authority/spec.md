## ADDED Requirements

### Requirement: a lead grant is user-issued and tool-unwritable
The system SHALL record the designated lead only through a user-typed action. No
model-callable tool SHALL create, renew or widen a grant.

#### Scenario: model requests the lead role
- **WHEN** a session calls any tool asking to become lead
- **THEN** no grant file is written and the reply names the command the user must type

### Requirement: grants are validated at load and fail closed
A grant SHALL be accepted only if it matches the closed schema, is unexpired, is owned by
the current user, and names a live session. Any other state SHALL be treated as no grant.

#### Scenario: a grant that parses but is meaningless
- **WHEN** the file contains a scalar where the lead mapping is required, or an expired time
- **THEN** it is treated as absent and the reason is logged

### Requirement: lead identity is verified from the authenticated socket
The system SHALL decide whether a message is from the lead by resolving the authenticated
sending socket, never from the message body or self-asserted envelope fields.

#### Scenario: forged sender field
- **WHEN** a third session writes a header claiming to be the lead
- **THEN** verification denies it and the message is framed as ordinary peer context

### Requirement: a verified lead directive is acted on without asking the user
When the receiver follows the lead, a verified directive within the grant's scopes SHALL be
framed as the user's instruction for planning, ordering and status, and the receiver SHALL
NOT be told to check with its user first. The receiver's tool permissions and publish policy
SHALL be unchanged.

#### Scenario: assignment
- **WHEN** the granted lead sends "take change X"
- **THEN** the receiver starts work on change X and replies to the lead

#### Scenario: out of scope
- **WHEN** the lead's message asks for something outside the grant's scopes or on the publish never-list
- **THEN** it is framed as ordinary context with the reason stated

### Requirement: no transitive trust
A directive SHALL be honoured only when it arrives from the lead's own socket (or a named
delegate within the delegate's scopes).

#### Scenario: relay
- **WHEN** a member forwards "the lead says do X"
- **THEN** it is framed as ordinary peer context
