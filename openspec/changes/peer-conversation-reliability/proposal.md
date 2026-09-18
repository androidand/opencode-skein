# Make local peer messaging reliable and conversational

## Status

Research and implementation planning. This change is intentionally local to the
repository for review before any GitHub issue is created or synchronized.

## Why

opencode-skein now discovers and messages both opencode-skein and Claude Code
sessions. The transport works end to end, but two user-facing failures remain:

1. An inbound peer message can corrupt the OpenTUI display with raw JSON or
   interleaved session/tool output. Resizing the terminal often causes the next
   frame to recover, which points to terminal-owned output or an unsynchronized
   render boundary rather than a delivery failure. The initial containment fix
   (draining sidecar stderr via `.resume()`) discards diagnostics rather than
   routing them to a non-terminal sink, so a crashing sidecar is now silent
   instead of merely noisy.
2. The receiving agent treats a peer message as an isolated prompt. It is not
   given a durable conversation/task identity, a clear expectation to reply, or
   a reliable way to associate a later response with the originating peer.
   Agents therefore often do some work and stop without answering the sender.
   One exception exists: `peer/delegate.ts` implements a working single-turn
   request/reply correlation for the subagent-overflow use case, but it uses a
   fragile text marker, has no `contextID` for multi-turn, no `notify` mode,
   and no delivery-state tracking.

The feature needs honest delivery semantics and a better agent experience without
turning every peer message into an unbounded autonomous conversation.

## What Changes

### 1. Establish a reproducible TUI-safe inbound path

Trace and test the complete inbound sequence from sidecar transport through
synthetic prompt, event publication, TUI SDK batching, reactive store updates,
and OpenTUI rendering. Terminal output must remain owned by OpenTUI while the
TUI is active. Diagnostics from sidecars and peer delivery must use the
application logger or another non-terminal sink.

The initial mitigation removes parent-side sidecar stderr/exit writes that could
tear through an OpenTUI frame. It is a containment fix, not yet proof that every
render race is solved, and it does not yet satisfy the "non-terminal logging
sink" requirement because diagnostics are discarded, not captured.

### 2. Generalize `peer/delegate.ts` into a peer conversation envelope

Introduce a small, transport-neutral peer envelope that generalizes the existing
`peer/delegate.ts` correlation mechanism rather than building a parallel one:

- message id (generated, not caller-supplied);
- sender and recipient session identity with a closed `harness` union
  (`opencode-skein` | `claude-code`);
- optional conversation/context id for multi-turn;
- optional in-reply-to message id;
- delivery mode (`notify` or `request`);
- response expectation and deadline.

The first implementation should support request/reply coordination without
requiring a new distributed task engine. A request should be acknowledged as
accepted independently from the eventual peer result. A reply should be another
peer message carrying the original context and correlation id. The existing
`[peer-task-result <taskID>]` text marker is kept as a fallback during
migration but is not the primary correlation mechanism.

### 3. Make inbound work actionable to the model

Update the injected peer prompt and tool descriptions so the receiving agent is
told whether the message is a notification or a request, who sent it, what
conversation it belongs to, and whether a response is expected. A request that
is accepted should result in a concise acknowledgement or a final answer, not
silent termination after unrelated work.

The agent must still retain its own permission boundary: peer text is context,
not a user instruction or permission grant.

Inbound requests must be admitted at a safe session loop boundary, not forked
with `startImmediately: true` as the current `local()` closure does. The
`steer-running-work` findings establish that delivery belongs at a safe loop
boundary; the current busy check is a coarse gate, not a safe-boundary
mechanism.

### 4. Expose progress and failure honestly

A sender should be able to distinguish:

- target resolved;
- message accepted for delivery;
- peer acknowledged receipt;
- peer is working;
- peer replied;
- peer failed, timed out, or became unreachable.

For the local implementation, this can begin as correlated session messages and
status metadata rather than a full A2A task API. Polling, streaming, or push
updates can be added only where the existing sidecar and session lifecycle can
support them reliably.

## Non-Goals

- No broadcast, group chat, or general-purpose message bus.
- No automatic permission elevation from peer content.
- No hidden chain-of-thought or transcript forwarding.
- No attempt to make Claude Code's private protocol a public compatibility
  contract; the adapter remains isolated behind the existing sidecar.
- No GitHub issue synchronization until the design and reproduction plan have
  been reviewed.
- No big-bang rewrite of `peer/delegate.ts`; the existing subagent-overflow
  path continues to work unchanged during migration.

## Dependencies

- Existing peer discovery and sidecar transport.
- Existing synthetic prompt and session event mechanisms.
- `peer/delegate.ts` (live) — the correlation skeleton to generalize.
- OpenTUI rendering and test harness behavior.
- Archived `peer-messaging`, `claude-peer-messaging`, and
  `steer-running-work` OpenSpecs.

## Impact

Likely implementation areas are:

- `packages/opencode/src/peer/claude/sidecar-manager.ts` and lifecycle wiring;
- `packages/opencode/src/peer/delegate.ts` — generalize the correlation
  mechanism, add structured envelope matching alongside the text marker;
- `packages/opencode/src/session/peers.ts` and peer routing;
- `packages/opencode/src/tool/send-peer-message.ts`, `peers.ts`, and their text
  descriptions;
- session prompt/processor scheduling and synthetic event publication —
  specifically the `local()` closure in `send-peer-message.ts:222-229`, which
  must be changed from `startImmediately: true` fork to safe-boundary enqueue;
- `packages/tui/src/context/sdk.tsx`, `sync.tsx`, and the OpenTUI app boundary;
- focused opencode and TUI regression tests.

## Addendum (second review, 2026-09-18)

Two of the AX failures had causes that needed no new envelope and are fixed
in the working tree (see `tasks.md`, "Implemented 2026-09-18"):

- The tool text told the model the Claude channel was one-way, so it never
  asked peers questions. It now says peers can answer and how replies arrive.
- Our outbound `from` was a placeholder no peer could reply to. It is now the
  sender's real sidecar socket whenever one exists.

Also fixed there: sidecar diagnostics routed to the app logger, duplicate
inbound frames dropped by `msg_id`, delivery forked on the app runtime rather
than the default console-logging one, and the receiver preamble naming the
correct harness with a usable reply target.
