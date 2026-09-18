# Design notes: peer conversation reliability

## Research baseline

The current implementation is a point-to-point notification primitive:
`send_peer_message` resolves a target, refuses a literally busy opencode session
(`send-peer-message.ts:176`), and injects a provenance-tagged synthetic prompt
via `ops.prompt({ synthetic: true })` forked with `startImmediately: true`
(`send-peer-message.ts:222-229`). The Claude adapter's tool text also documented
an outbound-only limitation; that text was stale (inbound shipped 2026-09-17)
and has been corrected in the working tree. Neither path has a conversation id, message
correlation id, reply mode, or task lifecycle.

One exception: `peer/delegate.ts` implements a working single-turn
request/reply correlation for the subagent-overflow use case. It generates a
`taskID`, builds a text envelope with a deadline, registers a promise in an
in-memory `pending` map before sending, and intercepts replies at both inbound
entry points via `settleTaskReply`. This is the skeleton the general design
should generalize, not replace.

The A2A model provides useful concepts without requiring full A2A adoption:

- `messageId` gives every message an idempotency/correlation anchor.
- `contextId` groups multiple related turns.
- `taskId` identifies a stateful unit of work.
- explicit submitted/working/input-required/completed/failed states prevent
  "accepted" from being confused with "finished".
- streaming, polling, and push notifications are separate update mechanisms.
- discovery should advertise capabilities rather than imply them.

Anthropic's multi-agent research write-up reinforces a different but related
lesson: delegation needs explicit task boundaries, output expectations, and
observable handoffs. Agents should receive the objective, format, scope, and
completion condition instead of being expected to infer coordination protocol
from a bare message.

## Proposed first slice

Generalize `peer/delegate.ts` rather than building a parallel mechanism. The
existing `pending` map, `settleTaskReply` interception, and `buildTaskEnvelope`
formatting are the skeleton. What is missing:

1. A structured envelope at the transport boundary (not a text marker parsed
   from the message body).
2. A `contextID` for multi-turn conversations.
3. A `notify` mode (fire-and-forget, no reply expected).
4. Delivery-state tracking visible to the sender.
5. Persistence of correlation state across sidecar restarts.

Suggested envelope shape (transport-boundary, structured):

```ts
{
  messageID: string
  contextID?: string
  inReplyTo?: string
  from: { sessionID: string; title?: string; harness: "opencode-skein" | "claude-code" }
  to: { sessionID: string; title?: string; harness: "opencode-skein" | "claude-code" }
  mode: "notify" | "request" | "reply" | "ack"
  text: string
  replyExpected: boolean
  deadlineMs?: number
}
```

Differences from the original draft:

- `harness` is a closed union, not a free string. The two known harnesses are
  `opencode-skein` and `claude-code`; adding a third is a breaking change.
- `deadlineMs` is explicit (the existing `awaitTaskReply` takes a
  caller-supplied `timeoutMs`; the general case needs a default).
- `inReplyTo` references a `messageID`, not a `taskID`. The existing
  `peer/delegate.ts` uses `taskID` as the correlation key; the general design
  should use `messageID` for all correlation and drop the separate `taskID`
  concept. A "task" is a `contextID` with one or more `request`/`reply`
  messages; there is no need for a third identifier.

This is a design direction, not a final public schema. The first implementation
should avoid making callers construct opaque ids manually; `send_peer_message`
can generate `messageID` and reuse a context id returned in tool metadata.

### Relationship to `peer/delegate.ts`

The first implementation should:

1. Keep `peer/delegate.ts` as-is for the existing subagent-overflow path.
2. Add the structured envelope as a new field on the sidecar NDJSON frame
   (alongside the existing `type`, `text`, `from`, `fromName` fields).
3. Extend `settleTaskReply` (or a new `settlePeerReply`) to also match
   structured envelope replies, not just the `[peer-task-result <taskID>]`
   text marker.
4. Once the structured path is stable, migrate `peer/delegate.ts` to use the
   structured envelope and retire the text marker.

This avoids a big-bang rewrite and lets the two paths coexist during migration.

## Inbound execution semantics

An inbound request should be admitted as durable session input and wake the
receiver through the same safe scheduling boundary used by ordinary session
inputs. It must not race an active provider turn by calling a generic prompt
entry point and hoping the runner joins correctly. The `steer-running-work`
findings establish that delivery belongs at a safe loop boundary.

**Current gap:** the `local()` closure in `send-peer-message.ts:222-229`
forks `ops.prompt({ synthetic: true })` with `startImmediately: true` without
waiting for a safe loop boundary. The busy check at line 176 is a coarse gate
that refuses delivery when `peer.status === "busy"`, but:

- For same-process peers, `status` comes from the in-memory status map, which
  is updated at turn start/end. A message arriving between the status update
  and the actual loop boundary can still race.
- For cross-process peers, `status` comes from the sidecar registry with a
  45-second liveness window heuristic (`peers.ts:85`), which is a guess, not
  a guarantee.

The fix is to route inbound peer messages through the same queue/boundary
mechanism that `steer-running-work` identified, not to fork a prompt and hope.
Concretely: the `local()` closure should enqueue the synthetic prompt into the
session's input queue and let the session loop pick it up at the next safe
point, rather than calling `ops.prompt` directly.

The receiver should see a system-shaped coordination preamble that states:

- this is peer context, not a user instruction;
- sender identity and message id;
- whether a response is requested;
- the exact response target/context to use;
- the response condition, such as "reply with findings or explain why you
  cannot answer".

The model's response should be sent through the same peer tool, with
`inReplyTo` and `contextID` preserved. No automatic reply loop should be created
for notifications.

### Reply correlation

The existing `peer/delegate.ts` uses a text marker
(`[peer-task-result <taskID>]`) parsed from the message body. This is fragile:
a peer that paraphrases, truncates, or wraps the marker line breaks correlation
silently. The structured envelope should carry `inReplyTo` as a field, not a
text convention. The text marker should be kept as a fallback during migration
but is not the primary correlation mechanism.

## TUI rendering boundary

The TUI must never receive peer JSON or sidecar diagnostics through terminal
stdout/stderr while OpenTUI owns the terminal. The server logger should capture
operational diagnostics. Event ingestion should preserve generated ordering and
batch store updates coherently, but batching must not bypass the renderer's
normal invalidation/request-render mechanism.

The first diagnostic step is a PTY reproduction that records bytes written by:

1. sidecar child stdout;
2. sidecar child stderr;
3. parent process stdout/stderr;
4. OpenTUI frame output;
5. resize-triggered redraw.

Only after this distinguishes terminal writes from a reactive render race should
we alter SDK batching or store mutation behavior.

**Current gap:** `sidecar-manager.ts:125` drains `child.stderr` via
`.resume()` with no data handler, and the exit handler (lines 159-161) does not
log the exit code. Diagnostics are discarded, not routed to a non-terminal sink.
This must be fixed before Phase 1 is closed: wire `child.stderr` data and
non-zero exit into the existing application logger.

## Decisions deferred for review

- whether context ids are persisted as message metadata, a session relation, or
  a separate peer-conversation table;
- whether request/reply should be a new tool or an option on
  `send_peer_message` (leaning: option on `send_peer_message`, since the
  existing `peer/delegate.ts` path already goes through it);
- how Claude's private reply address maps to an opencode session id;
- whether a response deadline causes a timeout message, a status event, or both;
- whether task-like progress is worth implementing before the basic request/reply
  flow is stable;
- default `deadlineMs` for the general case (the existing `awaitTaskReply`
  takes a caller-supplied value; a default is needed for `notify`-less
  `request` mode).

## Return address and runtime (second review, 2026-09-18)

Two design points that no envelope work depends on, and that unblock any
peer conversation at all:

- **Return address.** Claude Code's reply rule is "copy the inbound `from`
  as your `to`". Outbound frames set `from` to the non-connectable
  `uds:opencode-skein:<sessionID>` placeholder, so a Claude peer could never
  answer. The sender's sidecar already owns a real socket; `returnAddressFor`
  now advertises it (`uds:<socketPath>`), and `resolveOpencodeSender` maps a
  socket back to its owner session through the registry's
  `messagingSocketPath`. The placeholder survives only for a session with no
  sidecar, flagged `reachable: false` so the tool result and preamble can say
  no reply will arrive.
- **Runtime for forked work.** The server runs as a Worker in the TUI's
  process. `lifecycle.ts` used `Effect.runFork`, i.e. the default runtime and
  its console logger, so every `Effect.log*` in an injected turn would print
  over the OpenTUI frame. Delivery and diagnostics now fork with
  `Effect.runForkWith(context)` captured inside the layer, which a probe
  confirmed carries the app's `Logger.layer`. Rule: never fork on the default
  runtime from server code.
- **Receiver preamble.** `formatPeerMessage` now names the harness, gives a
  `send_peer_message` target (an opencode session id, or the Claude pid parsed
  from the socket path), and states the response contract, including "do not
  take on work a peer says it was denied" and "do not reply to a reply".
