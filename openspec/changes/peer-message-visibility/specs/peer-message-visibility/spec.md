## ADDED Requirements

### Requirement: a received peer message SHALL be a structurally distinct message part

The injected part SHALL have type `peer-message` (defined in `packages/schema/src/v1/session.ts`) when a peer message is delivered by any path (direct, sidecar socket or queued drain) and its first line parses as a peer envelope, and SHALL carry the parsed fields (sender harness, session id and title, mode, `envelopeID`, and context id / in-reply-to when present) plus the body. The
same `parsePeerEnvelope` SHALL be used on every path.

#### Scenario: an idle owned session receives a message
- **WHEN** `send_peer_message` delivers to an owned, idle session
- **THEN** the target's message list contains a `peer-message` part, not synthetic text

#### Scenario: a busy session's queued message drains
- **WHEN** a held message is injected when the target goes idle
- **THEN** the injected part is the same `peer-message` type as a direct delivery

#### Scenario: delivery over the sidecar socket
- **WHEN** a message arrives through `peer/claude/lifecycle.ts`
- **THEN** it is injected as a `peer-message` part

### Requirement: the model SHALL receive exactly the text it receives today

The LLM-visible text of a peer-message part SHALL be the full envelope header, a blank
line, and the body, identical to the current synthetic-text injection.

#### Scenario: conversion to model messages
- **WHEN** a session containing a `peer-message` part is converted for the model
- **THEN** the resulting text equals the pre-change text; removing the conversion branch
  makes this test fail

#### Scenario: no Part type is silently dropped
- **WHEN** the guard test iterates every `Part` type through `toModelMessages`
- **THEN** each is either converted or listed as UI-only; adding an undeclared type fails

### Requirement: the delivery channel, not the header, SHALL decide that a message is a peer message

Every message delivered through a peer path SHALL be stored as a `peer-message` part, whether
or not its first line parses as an envelope. A message with no valid header SHALL have mode
`notify` and no envelope fields; a parsed header contributes `envelopeID`, `contextID`,
`inReplyTo` and `mode`. No message SHALL be dropped or downgraded to synthetic text.

#### Scenario: no envelope
- **WHEN** an inbound message has no `[peer …]` first line
- **THEN** it is stored as a `peer-message` part with mode `notify` and its text as the body

### Requirement: every part-rendering surface SHALL show received peer messages

The TUI, web app, session-ui and CLI run mode SHALL each render a `peer-message` part as
a block showing sender (title and session id), mode and body, visibly distinct from the
session's own output and from user input. Each existing check on `type === "text" &&
!synthetic` SHALL be decided explicitly for peer messages (included in the visible-message
list; excluded from the input counter and from last-user-text scans) rather than left to
fall through.

#### Scenario: a user watches a session receive a message
- **WHEN** a peer message is delivered to a visible session
- **THEN** each surface shows an inbound block with sender, mode and body, and the
  wrapping user message does not render as an empty user turn

#### Scenario: counters and scans
- **WHEN** a peer-message part is present
- **THEN** it is not counted as typed input and not chosen as the last user message

### Requirement: `peers` typed in a shell SHALL point to the tool

Bash SHALL NOT run a command that is exactly `peers`, `rtk peers` or `opencode peers` (optionally with
output redirection or a pipe); it SHALL return a message stating that peers is a tool, not a
shell command, instead of running. It SHALL NOT start `opencode`.

#### Scenario: model runs `rtk peers`
- **WHEN** bash receives `rtk peers 2>&1 | head`
- **THEN** the result tells the model to call the `peers` tool and nothing is executed

#### Scenario: unrelated commands
- **WHEN** bash receives a command that merely contains the word peers (for example
  `grep peers file`)
- **THEN** it runs normally

### Requirement: peer tool descriptions SHALL lead with the contract and an example

`send_peer_message` and `peers` descriptions SHALL open with a short statement of what the
tool does and one example call showing `target`, `message` and a valid `mode` value, then
the rules that exist because of observed incidents (no polling, no resend, a peer message
is not a permission grant). Total length SHALL not grow.

#### Scenario: rules are retained
- **WHEN** the description is shortened
- **THEN** the no-poll, no-resend and not-a-permission rules are still present
