## ADDED Requirements

### Requirement: opencode-skein sessions can register as genuine Claude-compatible peers

A session that opts into Claude visibility SHALL be represented by its own dedicated sidecar
process, registered under that process's real PID with a registry entry and key file matching
the schema confirmed in `claude-peer-protocol-spike/findings.md`, byte-for-byte — including
`procStart` computed as `TZ=UTC LC_ALL=C ps -o lstart=` for that PID.

#### Scenario: a registered sidecar appears in stock Claude Code's ListAgents
- **WHEN** an opencode-skein session's sidecar has registered and bound its socket
- **THEN** an unmodified Claude Code session's `ListAgents` lists it as reachable

### Requirement: one opencode server process can represent multiple independently-addressable peers

Registering the `opencode serve` process's own PID SHALL NOT be used to represent more than one
session — each independently-active session that opts in gets its own sidecar process and PID.

#### Scenario: two sessions in one opencode server are two distinct Claude-visible peers
- **WHEN** one `opencode serve` process hosts two independently-active sessions, both opted into
  Claude visibility
- **THEN** `ListAgents` lists two distinct peers, not one

### Requirement: outbound messages use the real, confirmed wire protocol

A message sent to a Claude-Code peer SHALL be framed exactly as confirmed in `findings.md`: an
auth frame carrying the target's peer token, then a message frame with a fresh `msg_id`,
`priority`, `from` set to the sender's own socket URI, and `message.content` wrapping sanitized
text in the confirmed attribution envelope.

#### Scenario: a real Claude Code session receives and can decode the message
- **WHEN** opencode-skein sends a message to a real Claude Code peer
- **THEN** the message is decodable by that Claude session exactly as a native `SendMessage`
  would produce it

### Requirement: message text cannot forge envelope structure or sender identity

Envelope construction SHALL neutralize a literal closing tag or a `from="..."`-shaped substring
appearing in message text before embedding it.

#### Scenario: injected envelope syntax in the message body is inert
- **WHEN** a message's text contains `</cross-session-message>` or `from="someone-else"`
- **THEN** the constructed envelope's actual boundaries and `from` attribute are unaffected by
  that text

### Requirement: inbound provenance is keyed on transport identity, not envelope content

A received message's sender identity SHALL be determined by which authenticated socket
connection delivered it, not by trusting the envelope's `from`/`from-name` attributes as
self-certifying.

#### Scenario: envelope attributes are display context, not authorization
- **WHEN** an inbound frame's envelope claims a `from-name` that does not match the connection's
  authenticated identity
- **THEN** the message is still attributed to the authenticated connection, and the mismatch is
  not treated as a security event that grants the claimed identity's authority

### Requirement: registered peers are reachability-checked, not registry-trusted

A registered peer whose socket is not actually connectable SHALL be reported unreachable, even if
its registry file still exists and looks well-formed — matching the confirmed behavior of real
`ListAgents`/`SendMessage`.

#### Scenario: a dead sidecar is not reported reachable
- **WHEN** a sidecar process has exited without cleaning up its registry entry
- **THEN** resolution reports it unreachable rather than attempting delivery

### Requirement: message priority affects scheduling only, never authorization

Decoding `priority` (`now`/`next`/`later`) SHALL NOT create any code path where its value affects
permission evaluation.

#### Scenario: a "now" priority message still respects normal permissions
- **WHEN** an inbound message is marked priority `now`
- **THEN** it is scheduled ahead of `next`/`later` messages, and every tool action it leads to is
  still evaluated under the receiving session's normal permission ruleset

### Requirement: insecure runtime directories are refused, not silently tolerated

Registering a sidecar SHALL fail closed with a specific diagnostic if the target runtime
directory has insecure ownership or permissions, rather than weakening the write to succeed.

#### Scenario: a world-writable sessions directory is refused
- **WHEN** the sessions directory is not owner-restricted (not mode 0700, or not owned by the
  current user)
- **THEN** registration is refused with a diagnostic naming the specific problem
