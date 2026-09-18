# Findings: peer conversation reliability

Date: 2026-09-18 (research), reviewed and corrected 2026-09-18 (second-agent review)

## Review verdict (2026-09-18)

The change points at the right two problems and its direction (named delivery
modes, correlation ids, honest delivery states, a response contract in the
inbound prompt) is sound and consistent with A2A, with Anthropic's multi-agent
write-up, and with Claude Code's own cross-session contract. Four findings
below change what the first slice should be:

1. **A request/reply mechanism already exists.** `packages/opencode/src/peer/delegate.ts`
   implements task ids, a reply marker, a deadline, and interception at both
   inbound entry points. The original findings said no correlation or task
   lifecycle exists anywhere; that is wrong. Phase 3 must generalize
   `delegate.ts`, not build a second mechanism beside it.
2. **The Claude return address is broken by construction.** Outbound frames
   carry `from: "uds:opencode-skein:<sessionID>"`, a deliberately
   non-connectable placeholder (`client.ts`). Claude Code's own reply rule is
   "copy the `from` attribute as your `to`", so a Claude peer that tries to
   answer fails. The sidecar already owns a real socket; the sender just
   never advertises it. This is the single highest-value AX fix and it needs
   no new envelope.
3. **The tool text lies to the model.** `send-peer-message.txt` and the
   success output still say the Claude channel is "outbound-only" and the
   Claude session "cannot reply back". Inbound shipped on 2026-09-17
   (`claude-peer-messaging`, Phase 3). An agent told replies are impossible
   will not ask questions, which is exactly the AX failure this change wants
   to fix. `peers.txt` says the opposite ("messageable"), so the two
   descriptions also contradict each other.
4. **The TUI hypothesis is right about the mechanism but likely wrong about
   the writer.** The server runs as a Bun `Worker` inside the TUI process
   (`cli/cmd/tui.ts:210`), so any in-process console/stderr write reaches
   the terminal OpenTUI owns. The removed `console.error` calls were one
   such writer. A second, untested candidate is more likely to produce the
   reported "raw JSON" symptom: `lifecycle.ts` runs inbound delivery with
   `Effect.runFork`, i.e. the default Effect runtime and its default console
   logger, not the app runtime whose logger is file-only. Every
   `Effect.logInfo`/`logError` emitted during the injected turn (the prompt
   loop logs `loop` and `exiting loop` per step) would then print structured
   `key=value` lines, with JSON-encoded values, straight to the terminal.
   Sidecar NDJSON itself cannot reach the terminal: both child pipes are
   consumed by the parent.

## Existing implementation (corrected)

- **Process topology.** The TUI (`packages/tui`) and the opencode server run
  in one OS process; the server lives in a `Worker` thread that shares
  stdout/stderr with the renderer. OpenTUI is created with
  `externalOutputMode: "passthrough"` (`packages/tui/src/app.tsx:194`).
- **Logging.** `packages/core/src/observability/logging.ts`: the app runtime
  installs a file logger only; a stderr logger is added only when
  `OPENCODE_PRINT_LOGS=1`. The logger is installed as a Layer
  (`observability.ts`, `mergeWithExisting: false`), so it applies to fibers
  run inside the app runtime. `lifecycle.ts`'s `deliver` uses
  `Effect.runFork` on the default runtime and therefore does not get it.
- **Claude inbound.** `sidecar-entry.ts` (separate process) receives frames on
  its UDS socket, `sidecar-server.ts` parses the envelope, and the child
  writes `{"type":"inbound", text, from, fromName, priority}` to piped stdout.
  The parent (`sidecar-manager.ts`) parses NDJSON and calls `deliver`.
  `msg_id` is present on the wire (a real correlation id per the
  `claude-peer-protocol-spike` findings) but is dropped in
  `sidecar-server.ts`; the parent never sees it, so duplicate frames after a
  reconnect cannot be detected.
- **Inbound injection.** `lifecycle.ts` `deliver` first offers the text to
  `settleTaskReply`, then wraps it with `formatPeerMessage` and calls
  `SessionPrompt.prompt` with a synthetic text part. It discards the
  envelope's `from` address, so a Claude-originated message is labelled
  `[peer message from opencode-skein session claude-code — "<name>"]`: wrong
  harness in the label, and no reply target the receiver can use with
  `send_peer_message` other than the display name. The Claude socket path
  contains the pid (`/tmp/cc-socks/<pid>.sock`), which `resolveClaudeTarget`
  already accepts as a target.
- **Busy handling is asymmetric.** `send_peer_message` refuses a same-process
  target whose status is `busy` and uses registry status for foreign targets.
  The inbound `deliver` path has no busy check at all. `SessionPrompt.prompt`
  persists the user message (`createUserMessage`) and then calls
  `Runner.ensureRunning`, which joins an in-flight run
  (`effect/runner.ts:126`). The step loop rebuilds the message list from the
  store each step and exits only when the last assistant message's parent is
  the last user message (`prompt.ts:1162–1234`), so a message persisted
  mid-turn is normally picked up at the next step. The loss window is
  between the loop's final exit check and the run state returning to Idle:
  a message persisted there is joined onto a run that has already decided to
  stop and sits unprocessed until something else prompts the session. This
  is the concrete race behind `steer-running-work`'s "silently loses the
  message" and it needs a test, not an assumption either way.
- **Existing request/reply.** `peer/delegate.ts`: `buildTaskEnvelope` renders
  `[peer-task <id>] <description>`, states cwd, the reply tool and address,
  the deadline in minutes, and "Normal tool permissions apply";
  `awaitTaskReply` is an in-memory pending map with a timeout;
  `settleTaskReply` intercepts `[peer-task-result <id>]` at both inbound
  entry points. Pending state is per process and lost on restart. Used by
  `tool/task.ts` for pool overflow only.
- **Outbound addressing.** `client.ts` sets `from` to
  `uds:opencode-skein:<sessionID>` and `route.ts` parses that prefix back
  into a session id for opencode→opencode socket delivery. The sender's own
  sidecar socket path is known to the parent (`activeSidecars()` returns
  `socketPath`) but never used as the return address.
- **Discovery.** The sidecar registration mirrors `status` idle/busy into the
  registry, so other processes can read whether an opencode peer is working.
  Claude's registry entries advertise `peerFeatures` (`notify_idle`,
  `reply_across_default_dirs`, `artifact_yield`); the sidecar advertises
  none.
- **TUI.** The TUI batches SDK events in a 16 ms window and mutates Solid
  stores inside `batch` (`packages/tui/src/context/sdk.tsx:61–80`); the
  transcript renders from those stores. `packages/tui/test/` exists and runs
  with `bun test`.
- **Tests.** `test/peer/claude/sidecar-manager.test.ts` and `sidecar-e2e.test.ts`
  spawn the real sidecar and are skipped when `claude` is not on `PATH`.
  `test/peer/delegate.test.ts` covers the marker parsing.

## Phase 0 implemented (2026-09-18, uncommitted)

See `tasks.md`, "Implemented 2026-09-18" for the list. In short: diagnostics
to the app logger, `runForkWith` on the layer's context (probe-confirmed),
`msg_id` passthrough with duplicate suppression, real return address with
registry-based sender resolution, harness-aware preamble with a reply target,
and truthful tool text. 99 focused tests pass; typecheck is clean. Not done:
PTY reproduction, step-boundary loss window, `mode`/`context` parameters,
live Claude reply round-trip.

## Initial fix applied (with caveats, superseded by the section above)

`packages/opencode/src/peer/claude/sidecar-manager.ts` no longer writes child
stderr or exit diagnostics to the terminal. Focused sidecar manager and E2E
tests pass, and `bun typecheck` passes. Three caveats from review:

- The uncommitted diff reformats the whole file with tabs and semicolons.
  The repo's prettier config is `semi: false`, `printWidth: 120`, default
  two-space indent (root `package.json`). Run prettier before committing or
  the diff is 247 lines for a 10-line change.
- `child.stderr?.resume()` discards diagnostics. The proposal and the
  requirement say diagnostics are "captured"; the code drops them. Route
  them to the app logger at warn level (bounded per line) so a crashing
  sidecar is still diagnosable from `opencode.log`.
- The non-zero exit is now silent too. Log it the same way.

This is a confirmed terminal-output hazard, but the reported corruption is
not yet reproduced in a PTY, and the `Effect.runFork` logger candidate above
has not been tested. Test it first: it is cheaper than a byte-level PTY
capture and it predicts the symptom (structured lines with JSON values) more
precisely than sidecar diagnostics do.

## Online research

### A2A Protocol Specification (v1.0.0)

Source: <https://a2a-protocol.org/latest/specification/> (latest released
version 1.0.0 at time of review)

Verified facts:

- `Message` requires `messageId`, `role`, `parts`; optional `contextId`,
  `taskId`, `referenceTaskIds`, `metadata`, `extensions`.
- Task states: `SUBMITTED`, `WORKING`, `INPUT_REQUIRED`, `AUTH_REQUIRED`
  (interrupted), `COMPLETED`, `FAILED`, `CANCELED`, `REJECTED` (terminal),
  plus `UNSPECIFIED`.
- Operations in 1.0 are named `SendMessage`, `SendStreamingMessage`,
  `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, and the
  push-notification-config CRUD. (The `message/send`, `tasks/get` spellings
  are the JSON-RPC binding of 0.2/0.3.)
- Message vs Task is the agent's discretion: it "MAY create a new Task ... or
  MAY return a direct Message response for simple interactions".
- Blocking is a send configuration (`returnImmediately`, default false: wait
  for a terminal or interrupted state).
- Idempotency is a MAY: "Agents may utilize the messageId to detect duplicate
  messages." The original findings phrased this as a requirement.
- Capabilities (`streaming`, `pushNotifications`, `extendedAgentCard`) are
  advertised in the Agent Card, not assumed.

What carries over: A2A is an HTTP/JSON-RPC/gRPC protocol between remote
agents. Here the transport is Claude's private local UDS protocol, which we
do not control. A2A is therefore a vocabulary and a set of semantics to copy
(message id, context id, explicit mode, accepted ≠ completed, capability
advertisement), not a wire format to adopt.

### Anthropic multi-agent research system

Source: <https://www.anthropic.com/engineering/multi-agent-research-system>

Verified points relevant here:

- A task handed to another agent needs "an objective, an output format,
  guidance on the tools and sources to use, and clear task boundaries".
- Subagents should write outputs to the filesystem "to minimize the 'game of
  telephone'" — a reply should point at files and commits, not paste them.
  `send-peer-message.txt` already says this for outbound; the reply contract
  should say it too.
- Long-running work is stateful and errors compound; durable execution and
  checkpoints, not conversational relay, carry state.
- Evaluate by end state, with small focused evals early, because valid
  paths differ between runs.

### Claude Code's own cross-session contract (observed 2026-09-18)

Source: the `SendMessage` tool description and a live inbound
`<cross-session-message>` received during this review. This is the contract
opencode peers must interoperate with, and it is the closest thing to an AX
best-practice baseline for local A2A:

- Reply rule: "To reply to an incoming message, copy its `from` attribute as
  your `to`." Our placeholder `from` breaks this.
- Delivery semantics: messages "enqueue and drain at the receiver's next tool
  round"; a successful send "means the message reached that session, not
  that its Claude read it". Same posture as our "accepted for delivery".
- A receiver in a different permission mode may hold cross-session messages
  for user approval or refuse them; a `[Cross-session delivery notice]`
  reports that back on the same machine. We have no equivalent notice.
- `notify_when_idle` is a one-shot idle notice, opt-in, and the guidance is
  explicit: "Never poll `ListAgents` in a loop or send 'are you done?'
  messages instead." This is the `notify_idle` peer feature in the registry
  and is the right shape for our "peer finished" signal.
- Permission boundaries are per session; asking a peer to do something your
  own session was denied is "cross-session permission laundering".
  `formatPeerMessage` already states half of this; the reply contract must
  state the other half (do not forward denied work to a peer).
- The harness appends its own coordination preamble to inbound messages
  (identity, provenance, reply instructions) outside the sender's text. Our
  `formatPeerMessage` does the same; it just needs correct content.

### Local prior art

- Archived `peer-messaging` established honest "accepted for delivery"
  semantics and intentionally avoided persistent message history.
- Archived `claude-peer-messaging` established the per-session sidecar, the
  private Claude socket constraints, and (Phase 3) inbound delivery. Its
  proposal text still describes the tool description's "outbound-only" note
  as current; it is not.
- Archived `claude-peer-protocol-spike` confirmed `msg_id` is a real
  correlation id and that `from` "doubles as the return address".
- Archived `steer-running-work` found that prompting a running session joins
  the in-flight run; see the corrected analysis above for where the loss
  window actually is.
- Archived `subagent-notification-reliability` demonstrates the repository's
  preference for reproducing the concrete wake-up path before choosing a fix.
- `peer/delegate.ts` (from the pool-overflow delegation change) is the
  in-tree request/reply prior art this change must extend.

## Open questions for implementation research

1. Does running `deliver` inside the app runtime (or providing the app logger
   to the forked fiber) remove the corruption on its own? If yes, the PTY
   byte capture becomes a regression test rather than a diagnosis step.
2. What is the observed behaviour when an inbound message lands in the
   loss window described above? Reproduce with a mocked provider that
   finishes while a second prompt is persisted.
3. Can `delegate.ts`'s pending map be made durable enough (per-session
   message metadata or a small table) that a reply after a server restart
   still settles, or is "reply becomes a normal peer message" acceptable for
   that case?
4. How should `route.ts` recognise an opencode sender once `from` becomes a
   real sidecar socket path: registry lookup by `messagingSocketPath` →
   `ownerSessionID`, or carry the session id in `from-name`?
5. What deadline is useful for a local request? `delegate.ts` already takes
   one in minutes; default it, and state it in the receiving prompt.
6. Should the sidecar advertise `peerFeatures: ["notify_idle"]` and honour
   Claude's `notify_when_idle` subscription, so a Claude sender gets the
   one-shot idle notice it expects instead of silence?

## Addressing bugs found from a real failed send (2026-09-18)

A live `send_peer_message` to an existing session returned "no session
matches that id". Reproduced from the store, not inferred:

```
ses_f4a87c12…  project 50659655…  /Users/andreas/dev/opencode-skein   (caller)
ses_f4bba39c…  project 2e4f2d5e…  /Users/andreas/dev/llama-skein      (target)
```

Three independent defects, each sufficient to cause it:

1. **The messaging roster was never machine-wide.** The tool's own
   description promises "an opencode-skein session anywhere (not just this
   directory)", but it built the roster from `session.list()`, which is
   scoped to `ctx.project.id` (`session.ts:548-555`), merged with
   `foreignRoster()`, which only carries sessions that some *other* process
   registered (`route.ts` skips `isManaged`). A sibling session in another
   project of the *same* process therefore appeared in neither set and was
   unreachable, while visible in the same window.
2. **Only sessions created while a server was running ever got an address.**
   `ensureSidecar` was called from the `Session.Event.Created` listener and
   nowhere else, so every session resumed from history had no sidecar, no
   registration, and no return address. The live registry confirmed it: one
   registration existed for the caller, none for the target.
3. **The registered name was frozen at the placeholder title.** The one live
   registration read `opencode:New session - 2026-09-18T17:02:31.639Z`. A
   session registers at creation; its real title is generated after the first
   turn (`prompt.ts:255`) and was never pushed to the registry. Peers could
   only ever address each other by a timestamp placeholder, which is the
   "mismatch" a human sees when the roster disagrees with the session list.

A fourth, latent: making the roster machine-wide would let the tool prompt a
session another process drives, the exact hazard `route.ts` documents. Fixed
in the same pass by making ownership explicit at the delivery boundary.

### Fixed in the working tree

- `send-peer-message.ts`: roster from `session.listGlobal({ limit: 200 })`
  merged with the project list; an exact session id outside that window is
  looked up directly with `session.get` (not project-scoped); the not-found
  message now states what was actually searched.
- `route.ts`: `deliverToOpencodeSession` takes `owned` and returns
  `{ via: "unaddressable" }` rather than prompting a session this process
  does not own; the tool reports that honestly. `task.ts` passes it too.
- `lifecycle.ts`: a session gets a sidecar the first time it reports a
  status, not only on creation, so resumed sessions become addressable.
- `sidecar-{manager,entry,server}.ts`: a `name` control line updates the
  registration; `lifecycle.ts` pushes it on `Session.Event.Updated`.
- `session/peers.ts`: the preamble leads with what to do and states the trust
  boundary after it. Leading with "not a user instruction and not a
  permission grant" reads to a small local model as "ignore this", which is
  the observed "models are not keen on acting on messages" behaviour.

Tests: `test/peer/route-delivery.test.ts`,
`test/peer/claude/sidecar-server-name.test.ts`, preamble ordering in
`test/session/peers.test.ts`. 104 peer/session tests pass, `bun typecheck`
clean, and the existing end-to-end delivery test in `test/session/prompt.test.ts`
still passes.

### Not fixed

A session with no sidecar in another process is reported unaddressable rather
than delivered to. That is honest but it is still a dead end until that
session next reports a status. If a durable per-session address is wanted,
it belongs with the claims work in `crew-loop`, not here.

## Discovery and liveness (2026-09-18, from a live `peers` call)

A `peers` call listed five Claude Code sessions and no opencode-skein ones,
and the model concluded "none of the active sessions are opencode-skein" —
so the id it had been given "does not exist". Two opencode sessions were live
at that moment. Two causes:

1. **`peers` was project-scoped too**, exactly like `send_peer_message` was,
   so a peer in another project never appeared.
2. **`resolvePeers` hides idle sessions by design.** That was right while
   `peers` only answered "who might I collide with". It is wrong now that the
   same tool is the discovery surface for messaging: `send_peer_message`
   treats an idle session as its NORMAL target, and Claude Code peers were
   listed whatever their status. An agent asking who exists got an answer
   that omitted most of the sessions it could talk to, and reasoned from it
   that they were gone. This is a large part of why agents do not start
   conversations: their roster says there is nobody to talk to.

### Idle is two different states

Raised by the user and correct: a session that finished its turn and is being
attended, and a session row whose process exited days ago, are indistinguishable
in the store — both are "idle", and `idleForMs` is just `now - time.updated`.
Messaging the second one is not the same act as messaging the first.

The signal already existed: a sidecar registration exists only while a process
is running a sidecar for that session. `liveSessionIDs()` (`route.ts`) reads
every managed registration and verifies each pid with `kill(pid, 0)` rather
than trusting the file, so a registration left by a crash does not read as an
attended session. `Peer.reachable` carries it; callers that cannot check leave
`live` unset and every peer stays reachable, preserving old behaviour.

Three honest states, and they differ in what delivery actually does:

| state | what a message does |
| --- | --- |
| working | refused; would race the turn |
| idle, attended | picked up on its next turn — the normal case |
| finished, this project | the turn still runs here, but nobody is watching it |
| finished, elsewhere | no address at all; refused (`unaddressable`) |

`peers` now lists working peers, then attended idle peers as explicit targets,
then counts the finished ones in the two variants above. `send_peer_message`
says on acceptance whether anyone is attending the target.

Tests: reachability and `describePeer` wording, `idlePeers` splitting and
overflow counting (`test/session/peers.test.ts`). 449 opencode peer/session/tool
tests pass, `test/session/prompt.test.ts` passes, `bun typecheck` clean.

## Live incident, 2026-09-18 evening: what four agents in one repo actually did

Three opencode sessions and two Claude Code sessions were run in this
checkout, on the 08:03 binary — i.e. with none of the fixes above. Everything
below was observed, not predicted.

1. **A session asked to "collaborate and sync with the peers" worked alone**,
   twice. There was nothing to collaborate about: no shared work item, no
   completion condition, and no obligation surviving the end of its turn. The
   roster it consulted hid every idle opencode peer and was scoped to its own
   project, so it was also told, truthfully for that build, that there was
   almost nobody there.
2. **Asked a third time, it went and fixed the merge state instead** — in a
   checkout three other sessions were working in, without telling any of them.
   It was careful with what it found: it stashed the uncommitted A2A work
   under a clear label and preserved a third session's WIP separately marked
   "not-mine". No work was lost. But nobody knew it was happening, and the
   review session briefly and wrongly reported its work destroyed.
3. **The merge it was fixing could not be fixed.** `origin/dev` and local
   `dev` have no common ancestor (718 local commits, 15775 remote, empty
   merge base), so all 110 files conflicted as added-by-both. It was aborted.
4. **A peer did exactly the right thing and could not be answered.** A session
   messaged the review session asking who authored the stashed work before
   touching anything. The reply failed: `ENOENT` on
   `uds:opencode-skein:ses_…`, the placeholder return address. Addressing the
   same session by its registered name worked. Both halves of the
   return-address bug, confirmed in one exchange.
5. **The roster showed the placeholder-name bug live**: two sidecars listed as
   `opencode:New session - 2026-09-18T18:53:57.761Z`, so the session that
   called itself "Greeting" in its message could not be found under that name.
6. **A session melted down retrying.** Told to ask peers what to do, it sent
   `"what to do"` to four pids several hundred times, exhausted its context,
   compacted, read its own goal back out of the summary, and resumed the same
   loop. Causes, in order: the tool returns an acknowledgement rather than an
   answer and nothing says the answer arrives later; the not-found result ends
   by naming a recovery step, which reads as an invitation to retry; nothing
   made a repeat cost anything; and the pids it was chasing were stale.

Direction-by-direction, on that build: opencode → Claude Code delivery works
(confirmed twice). Claude Code → opencode works when addressing a session by
its registered name. Claude Code → opencode fails when replying to the address
opencode advertises. So from the opencode side replies never arrive, its tool
text says they cannot, and the belief is self-confirming.

### Fixed in response (in the working tree, tested)

- `peer/repeat-guard.ts`: a bounded, windowed repeat counter.
  `send_peer_message` refuses an identical message to the same peer inside 90 s
  and explains that an answer never returns from the call; a repeated
  unresolvable target inside 180 s is told to stop trying rather than to call
  `peers` again.
- `send-peer-message.txt` states the asynchronous contract first: send once,
  the reply arrives later as a new turn, never poll, never loop over targets.

### Still open

Everything here is uncommitted and nothing is deployed; the sessions that
produced this incident were running the morning build. Until it ships, the
roster keeps hiding idle peers, the return address stays unreachable, and the
retry loop stays possible.
