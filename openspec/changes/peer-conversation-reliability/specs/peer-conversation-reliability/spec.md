## ADDED Requirements

### Requirement: peer delivery SHALL not write raw protocol or diagnostic data into the active TUI terminal

Peer transport frames, sidecar diagnostics, and log output from any server-side fiber SHALL be
consumed by application code or the application logger while OpenTUI owns the terminal. This
includes fibers forked for inbound delivery. They SHALL NOT be written to the process's terminal
stdout or stderr streams.

Sidecar stderr SHALL be captured and routed to the application logger; it SHALL NOT be silently
drained. A non-zero sidecar exit SHALL be logged with the exit code and signal.

#### Scenario: an inbound peer message arrives while the TUI is active
- **WHEN** a sidecar receives a peer message and the parent delivers it to a session
- **THEN** the terminal receives only renderer-owned output, not the sidecar's NDJSON frame, diagnostic text, or Effect log lines from the injected turn

#### Scenario: sidecar diagnostics occur while the TUI is active
- **WHEN** a sidecar writes stderr or exits unexpectedly
- **THEN** the diagnostics are recorded in the application log with the exit code (if applicable) and nothing is written to the terminal

### Requirement: an outbound peer message SHALL carry a reachable return address when one exists

When the sending session has a live sidecar, the frame's `from` SHALL be that sidecar's socket
address so a Claude Code peer's own reply rule (reply to `from`) reaches the sender. When no
sidecar exists, the message SHALL state that no reply can arrive.

#### Scenario: a request is sent to a Claude Code peer
- **WHEN** `send_peer_message` sends to a Claude Code session from a session with a sidecar
- **THEN** the Claude session can reply by sending to the `from` address and the reply is delivered to the originating opencode session

#### Scenario: a sender without a sidecar sends a request
- **WHEN** the sending session has no live sidecar
- **THEN** the tool result and the receiver's preamble state that a reply cannot be delivered, and the mode is treated as `notify`

### Requirement: a peer message SHALL carry an explicit mode and enough identity for a correlated reply

Every peer message SHALL have a generated message id that is also the transport frame's message
id, an explicit mode (`notify`, `request`, or `reply`), a sender address with a closed `harness`
union (`opencode-skein` | `claude-code`), and a recipient address. A `request` SHALL carry a
context id and a deadline. A `reply` SHALL carry the context id and the id of the message it
answers. Header values SHALL be sanitised so message text or session titles cannot forge them.

The structured envelope fields SHALL be present at the sidecar NDJSON transport boundary. The
existing `[peer-task-result <taskID>]` text marker in `peer/delegate.ts` SHALL be kept as a
fallback during migration but SHALL NOT be the primary correlation mechanism.

#### Scenario: a request is delivered to an opencode peer
- **WHEN** `send_peer_message` sends with mode `request`
- **THEN** the receiver can identify the sender, message id, context id, deadline, and the exact target and ids to reply with

#### Scenario: a reply is sent for a request
- **WHEN** the receiver answers a peer request
- **THEN** the reply preserves the context id and identifies the originating message via the `inReplyTo` field, and it settles the sender's pending request instead of being injected as a new prompt

#### Scenario: a legacy text-marker reply arrives during migration
- **WHEN** an inbound message matches the `[peer-task-result <taskID>]` pattern and the structured envelope is absent
- **THEN** the reply is still correlated via the text marker and settled into the pending request

### Requirement: duplicate inbound frames SHALL be dropped by message id

The inbound path SHALL pass the frame's message id through the sidecar to the parent, and the
parent SHALL ignore a message id it has already delivered to the same session within a bounded
window.

#### Scenario: a frame is received twice after a reconnect
- **WHEN** the same message id arrives twice for one session
- **THEN** the session receives one prompt

### Requirement: delivery acknowledgement SHALL be distinct from peer completion, and SHALL only claim what the harness can observe

The sender-facing result SHALL distinguish resolved, accepted for delivery, working, replied,
failed or timed out, and unreachable. A successful send SHALL NOT imply that the peer read,
processed, or answered the message. Receipt acknowledgement SHALL NOT be claimed for a Claude
Code peer.

The existing `peer/delegate.ts` `pending` map covers accepted, replied, and timeout states. The
general design SHALL add acknowledged and working states without breaking the existing
single-turn task delegation path.

#### Scenario: a request is accepted for asynchronous processing
- **WHEN** the target is resolvable and the message is admitted
- **THEN** the sender receives an accepted-for-delivery result with its message id and context id

#### Scenario: the peer cannot complete the request
- **WHEN** the deadline passes without a correlated reply, or the peer becomes unreachable
- **THEN** the sender receives exactly one correlated timeout or failure message and nothing polls the peer

### Requirement: inbound delivery SHALL land at a safe step boundary

An inbound peer message admitted while the target session is mid-turn SHALL be processed by
that session either in its current run at the next step or in a new run after it. It SHALL NOT
be persisted and then left unprocessed because it joined a run that had already decided to stop.
It SHALL NOT be forked with `startImmediately: true` into a scope that races an active provider
turn.

The current `local()` closure in `send-peer-message.ts` forks `ops.prompt({ synthetic: true })`
with `startImmediately: true`. This SHALL be changed to enqueue the synthetic prompt into the
session's input queue and let the session loop pick it up at the next safe point.

#### Scenario: a message arrives during the final step of a turn
- **WHEN** a peer message is persisted after the step loop's final exit check and before the run returns to idle
- **THEN** the session still processes the message without waiting for an unrelated prompt

#### Scenario: a message arrives while a provider turn is active
- **WHEN** a peer message is admitted while the target session is mid-provider-turn
- **THEN** the message is enqueued and processed at the next safe loop boundary, not forked into the active turn

### Requirement: peer prompts SHALL state the response contract and the correct provenance

An inbound message SHALL name the sending harness correctly, state that the content is peer
context rather than a user instruction or permission grant, state that work a peer reports as
denied is not to be performed on its behalf, and give the mode-specific response condition.

The injected coordination preamble SHALL include:
- the sender's harness and session identity;
- the message id and context id (if present);
- the mode (`notify`, `request`, or `reply`);
- whether a response is expected and, if so, the deadline;
- the exact target and ids to use when replying.

#### Scenario: an agent receives a request requiring findings
- **WHEN** a peer request is admitted into the receiving session
- **THEN** the agent is instructed to perform the bounded request and reply, before the deadline, with findings pointing at files and commits or with an explicit inability to answer

#### Scenario: an agent receives a notification
- **WHEN** a peer notification is admitted into the receiving session
- **THEN** the agent is told no reply is expected and is not forced into a reply loop

#### Scenario: an agent receives a reply
- **WHEN** a peer reply is admitted into the receiving session as a prompt (its request is no longer pending)
- **THEN** the agent is told it closes a request and not to reply unless the reply asks something new

#### Scenario: a Claude Code peer sends a message
- **WHEN** an inbound message arrives over the sidecar from a Claude Code session
- **THEN** the preamble names it as a Claude Code session and gives a target the agent can pass to `send_peer_message`

### Requirement: tool descriptions SHALL describe the channel truthfully

`send_peer_message` and `peers` descriptions and results SHALL agree with each other and with
the implemented capability, including that Claude Code peers can reply.

#### Scenario: the model reads the send tool description
- **WHEN** inbound Claude messaging is enabled
- **THEN** no description or result text states that the Claude channel is outbound-only

### Requirement: the structured envelope SHALL generalize `peer/delegate.ts` without breaking the existing subagent-overflow path

The existing `peer/delegate.ts` correlation mechanism SHALL continue to work unchanged for the
subagent-overflow use case during migration: its pending map, `settleTaskReply` interception,
and `buildTaskEnvelope` formatting stay as they are. The structured envelope SHALL be added as new
fields on the sidecar NDJSON frame. Reply settlement SHALL match both the structured envelope
and the legacy text marker during the migration period.

#### Scenario: a subagent overflow delegation uses the legacy path
- **WHEN** `tool/task.ts` delegates a subagent to an idle peer via `peer/delegate.ts`
- **THEN** the delegation and reply correlation work as before, using the text marker

#### Scenario: a general peer request uses the structured envelope
- **WHEN** `send_peer_message` sends with mode `request` and a structured envelope
- **THEN** the reply is correlated via the `inReplyTo` field and settled into the pending request

#### Scenario: both paths coexist during migration
- **WHEN** a legacy text-marker reply and a structured envelope reply arrive in the same session
- **THEN** both are correctly correlated and settled without interference
