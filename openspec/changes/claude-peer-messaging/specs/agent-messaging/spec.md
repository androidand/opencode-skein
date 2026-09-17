## ADDED Requirements

### Requirement: messaging is opt-in and version-gated

Outbound peer messaging SHALL be disabled by default, enabled only by explicit
configuration, and SHALL refuse to send when the peer advertises a protocol version the
implementation was not written against.

#### Scenario: disabled by default

- **WHEN** the experimental flag is unset
- **THEN** no peer socket is opened and no control capability is advertised as available

#### Scenario: an unknown protocol version

- **WHEN** a peer advertises a protocol version other than the supported one
- **THEN** sending is refused with a message naming the observed version, and no data is
  written to the socket

### Requirement: capabilities are advertised only when performable

A peer record SHALL advertise a control capability as available only when that control can
actually be exercised against that peer at that moment.

#### Scenario: an unreachable peer

- **WHEN** a peer's socket no longer exists
- **THEN** its control capabilities are published as unavailable

### Requirement: peer credentials never leave the moment of use

Peer authentication tokens SHALL be read only when a message is being sent, and SHALL NOT
be logged, persisted, included in error messages, or placed in any model-visible context.

#### Scenario: a send fails

- **WHEN** authentication against a peer fails
- **THEN** the error names the peer and the failure, and contains no token material

### Requirement: message identity is verified before sending

Before connecting, the implementation SHALL verify that the process owning the socket is
the process the registry entry describes.

#### Scenario: a reused pid

- **WHEN** a registry entry's pid is alive but its process start time does not match
- **THEN** the send is refused and the peer is reported as stale

### Requirement: messages carry structured facts with a stated source

Messages SHALL be constrained to observations, claims and results attributable to a stated
source, and SHALL NOT be used to relay free-form reasoning or transcripts between agents.

#### Scenario: a result is shared

- **WHEN** an agent reports a failing test suite to a peer
- **THEN** the message carries the suite, the outcome and the originating session

#### Scenario: transcripts are not relayed

- **WHEN** an agent attempts to send conversation content
- **THEN** the message shape does not accommodate it
