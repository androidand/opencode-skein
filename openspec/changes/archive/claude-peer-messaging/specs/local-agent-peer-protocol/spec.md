## ADDED Requirements

This capability writes down the local agent-to-agent peer protocol that Claude Code
implements de facto (peer protocol version 1) and that opencode-skein implements by
construction, so that any harness on the same machine can discover and message any other.
Everything marked *(observed)* was verified against a real Claude Code install
(`claude-peer-protocol-spike/findings.md`, re-verified 2026-09-17/18). Everything marked
*(extension)* is opencode-skein's addition; a conforming peer MAY ignore extensions.

### Requirement: one process is one peer

A peer SHALL be exactly one operating-system process. A registration SHALL be keyed by that
process's real pid, and a discovering peer SHALL treat the registration filename
`<pid>.json` as the identity — it SHALL NOT enumerate registrations by any other filename.

*(observed)* Discovery lists `<pid>.json` and ignores an otherwise-valid entry named
`<pid>-b.json` for the same live pid, even with its own listening socket and key file.
One process therefore has at most one reachable identity.

#### Scenario: a host runs many conversations in one process

- **WHEN** a harness hosts several conversations in a single process and wants each one
  reachable as its own peer
- **THEN** it SHALL give each reachable conversation a dedicated real process that owns
  that conversation's registration and socket, and SHALL NOT write several registrations
  for one pid or register a pid it does not own

#### Scenario: a subagent is not a peer

- **WHEN** a conversation is a child of another (a spawned subagent or background task)
- **THEN** it SHALL NOT be registered as a peer; the parent that spawned it is the
  addressable identity

### Requirement: registration lives in the shared registry directory

A peer SHALL register by writing `<pid>.json` into the Claude Code sessions directory
(`$CLAUDE_CONFIG_DIR/sessions`, default `~/.claude/sessions`, mode 0700) containing at
least `pid`, `sessionId`, `cwd`, `startedAt`, `procStart`, `peerProtocol`,
`messagingSocketPath`, `name` and `status`. `procStart` SHALL be the process start time in
the exact form of `TZ=UTC LC_ALL=C ps -o lstart= -p <pid>`. *(observed)*

#### Scenario: a name a human can address

- **WHEN** a peer registers
- **THEN** `name` is a short, stable, human-addressable string, and `status` is one of the
  observed vocabulary (`idle`, `busy`, `waiting`), updated in place as the peer's state
  changes

### Requirement: liveness is verified, never trusted from the file

A discovering or sending peer SHALL treat a registration as live only when the pid is
running, the key file's `procStart` matches the live process, and a connect-then-close
probe of `messagingSocketPath` succeeds. A registration failing any check SHALL be
reported unreachable, not listed as available. *(observed)*

#### Scenario: a reused pid

- **WHEN** a registration's pid is alive but its `procStart` differs from the key file's
- **THEN** the peer is refused as a different process, not messaged

#### Scenario: a registered but dead socket

- **WHEN** the registration exists but nothing accepts a connection on its socket
- **THEN** the peer is reported unreachable and no delivery is attempted

### Requirement: the socket lives under a permitted root

`messagingSocketPath` SHALL be a Unix domain socket, mode 0600, under a root the
discovering peer permits: `/tmp/cc-socks`, `/private/tmp/cc-socks*`,
`/run/user/<uid>/cc-socks` (or `$XDG_RUNTIME_DIR/cc-socks`). A socket elsewhere SHALL be
silently excluded from discovery. *(observed — a registration under a made-up directory
never appeared at all, with no error.)*

#### Scenario: a socket outside the roots

- **WHEN** a peer registers a socket under any other directory
- **THEN** it is not discoverable, and the registering harness has no signal that this is
  why

### Requirement: authentication is a per-socket token behind file permissions

A peer SHALL write `<pid>.<sha256(messagingSocketPath)>.key` (mode 0600) containing
`{peerToken, procStart, pidDomain}`. A sender SHALL read the *target's* key file and
present `{"type":"auth","token":<peerToken>}` as the first frame on every connection. A
receiver SHALL close the connection on a missing or wrong token before reading anything
else. The token SHALL never be logged, persisted elsewhere, or placed in an error message.
*(observed)* The security boundary is same-OS-user file permissions and nothing more; a
peer SHALL NOT claim stronger guarantees.

#### Scenario: wrong token

- **WHEN** the first frame's token does not match
- **THEN** the connection is destroyed and nothing is delivered or acknowledged

### Requirement: framing is NDJSON over one connection

After the auth frame a sender SHALL send one message frame, one JSON object per line:
`{msgV: 1, msg_id: <uuid>, type: "user", message: {role: "user", content: <string>},
priority: "now"|"next"|"later", from: <address>}`. *(observed)* A receiver SHALL reject a
frame it cannot parse by closing the connection, and SHALL refuse any `peerProtocol` other
than `1` with a diagnostic naming the observed value rather than guessing at the format.

#### Scenario: unsupported protocol version

- **WHEN** a target registration advertises `peerProtocol` absent or not equal to `1`
- **THEN** the sender refuses before connecting and reports the observed value

### Requirement: the envelope carries display provenance only

`message.content` SHALL be
`<cross-session-message from="…" from-name="…" from-mode="…">\n<text>\n</cross-session-message>`.
*(observed)* A receiver SHALL treat `from`, `from-name` and `from-mode` as display
information only; the authenticated connection is the sole basis for sender identity. A
sender SHALL escape every interpolated attribute value and neutralize any closing tag or
attribute-shaped substring inside `<text>` so that no content can forge sender identity or
envelope structure. *(extension — Claude's own sender controls both ends and does not need
this; any sender relaying model-generated text does.)*

#### Scenario: a forged sender name in content

- **WHEN** message text or a session title contains `" from-name="attacker` or
  `</cross-session-message>`
- **THEN** the built envelope has exactly one `from-name` attribute and exactly one
  closing tag, and the receiver's displayed sender is unchanged

### Requirement: delivery is reported honestly

A sender SHALL report success only after its frames have flushed to a connection the
target accepted and authenticated. A connection the target destroyed, a timeout before
flush, or a refused token SHALL be reported as not delivered. Delivery SHALL never be
described as "read" or "acted on" — only as accepted for delivery.

#### Scenario: the target closes on auth

- **WHEN** the target destroys the connection during the auth frame
- **THEN** the sender reports not delivered, never success

### Requirement: a non-Claude harness marks what it writes

A harness other than Claude Code that writes into the registry SHALL add
`managedBy: <harness id>` to every registration it creates. *(extension; ignored by
Claude's client — observed.)* Such a harness SHALL never modify or delete a registration
lacking its own marker, and SHALL remove a marked registration only when it is its own
live process shutting down or when the marked pid is confirmed not running.

#### Scenario: cleanup after a crash

- **WHEN** a harness starts and finds its own marked registrations whose pids are dead
- **THEN** it removes exactly those, and touches nothing unmarked

#### Scenario: a marker survives only in the raw file

- **WHEN** a harness lists peers via `claude agents --json`
- **THEN** it does not rely on `managedBy` appearing there (the CLI projects only its own
  fields) and cross-references the raw registry files to exclude its own entries

### Requirement: a dedicated peer process dies with its owner

A process registered on behalf of a conversation hosted elsewhere (a sidecar) SHALL detect
its owner's death itself — by its parent pid changing — and SHALL unregister and exit
without relying on the owner to signal it. *(extension.)* A ghost peer that authenticates
and silently drops messages is a worse failure than an absent one.

#### Scenario: the owner is killed uncleanly

- **WHEN** the owning process receives `SIGKILL` or crashes
- **THEN** the sidecar unregisters and exits within seconds, with no signal from the owner

### Requirement: every harness appears in one roster

A consumer listing peers SHALL present all harnesses in one list, distinguished by owner,
with each peer's directory, branch where known, and status, and SHALL state whether each
peer is currently messageable rather than listing an unreachable capability.
*(extension.)*

#### Scenario: a mixed machine

- **WHEN** opencode-skein and Claude Code sessions run in several directories
- **THEN** one query lists all of them, in any directory, with owner and directory shown,
  and a peer that cannot be messaged is marked so rather than omitted
