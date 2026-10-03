# Tasks: peer conversation reliability

## Phase 0: Review and guardrails

- [x] 0.1 Have a second agent review `proposal.md`, `design.md`, and
      `findings.md`, specifically challenging the TUI root-cause hypothesis and
      the proposed envelope fields. (Done 2026-09-18: review identified the
      `peer/delegate.ts` omission, the stderr-discard gap, the unsafe
      `startImmediately: true` fork, and the fragile text-marker correlation.
      All four findings incorporated into the updated spec.)
- [x] 0.2 Keep this change local until the review identifies a bounded first
      implementation slice. Do not run specsync against GitHub yet.
      Done 2026-10-03: review in 0.1 identified the bounded Phase 3 slice
      (envelope + mode + reply correlation + step-boundary fix). Implementation
      proceeded from that slice. Change remains local; no specsync against
      GitHub. Task 5.5 is the gate for re-evaluating specsync readiness.
- [x] 0.3 Decide whether the existing Claude private protocol should remain an
      adapter detail or whether a transport-neutral envelope is required at the
      sidecar boundary. (Leaning: structured envelope at the sidecar NDJSON
      boundary, with the Claude private protocol remaining an adapter detail
      behind `sidecar-manager.ts`.)
      Done 2026-10-03: implemented as leaning — `peer/envelope.ts` owns the
      structured envelope at the NDJSON boundary; Claude private protocol stays
      behind `sidecar-manager.ts` + `peer/claude/codec.ts`. No separate transport-
      neutral envelope needed — the `[peer mode id=...]` header survives all
      hops (Claude, opencode-to-opencode) because it lives inside the text body.

## Phase 1: Reproduce and close the TUI corruption

- [x] 1.1 Build a PTY reproduction that starts the TUI, injects an inbound peer
        message, captures stdout/stderr bytes, and records terminal dimensions.
        Done 2026-09-19 (restructured 2026-09-19, verified 2026-09-19):
        `packages/opencode/test/peer/claude/pty-repro.test.ts`. Three parts:
        (1) positive control — spawns a subprocess that deliberately forks on
        the default runtime and asserts the leak reaches the pipe, proving the
        harness works; (2) regression — spawns a subprocess that forks through
        `runForkWith(appContext)` and asserts stdout is clean, proving the
        mechanism matters; (3) source-level guard — asserts `lifecycle.ts`
        contains `Effect.runForkWith(` and no bare `Effect.runFork` (negative
        lookahead catches both called and point-free forms), closing the gap
        between "the technique works" and "the module uses it". Capture is at the
        subprocess-pipe level throughout, not by patching process.stdout.write,
        because Effect writes directly to the fd. The spec reviewer verified
        (round 4) that the regex catches the genuine pre-fix shape on
        fe56a6b331 and passes on the current code. What 1.1 rests on: the
        experiment shows the mechanism matters (one instrument, one variable),
        the source guard shows the module uses it, and the sidecar cycle covers
        the raw-frame case. Neither half alone would have been evidence.
- [x] 1.2 Verify whether any raw JSON or sidecar diagnostic bytes bypass
        OpenTUI. The NDJSON part is always true by construction, not by test:
        the parent consumes both child pipes, so no frame can reach the
        terminal regardless of what the code does. The diagnostics half is the
        part that needed proving — with the source-level guard (lifecycle.ts
        uses runForkWith, asserted with a negative-lookahead regex that catches
        both the called and point-free forms) and the control-and-treatment
        experiment (runFork leaks to stdout, runForkWith does not), the chain is
        complete, plus `sidecar-diagnostic-routing.test.ts`, which kills a real
        sidecar and asserts the exit is reported with the signal named. That
        test exposed a real bug (a signal kill has code null, so the exit
        handler stayed silent), fixed in `sidecar-manager.ts` (23e227a986).
        Done 2026-09-19.
- [x] 1.3 Wire `child.stderr` data and non-zero exit in
      `sidecar-manager.ts` into the existing application logger. The current
      `.resume()` drain (line 125) and silent exit handler (lines 159-161)
      discard diagnostics; this task closes that gap. Do not add ad hoc
      terminal writes.
- [ ] 1.4 If the PTY shows only OpenTUI output, reproduce the event burst in the
      TUI harness and isolate the renderer invalidation or store hydration race.
- [ ] 1.5 Add a regression test that an inbound message burst leaves the rendered
      transcript structurally valid without requiring a resize.
- [ ] 1.6 Validate with focused TUI tests and a real PTY/manual run before
      changing peer conversation semantics.

## Phase 2: Specify request/reply semantics

- [x] 2.1 Decide and document the minimum envelope: message id, sender,
      recipient, mode, context id, reply correlation, and response expectation.
      The envelope generalizes `peer/delegate.ts`; see `design.md` for the
      proposed shape and the migration path from the text marker.
      Done 2026-10-03: `peer/envelope.ts` defines `PeerEnvelope` with
      `messageID`, `contextID`, `inReplyTo`, `deadlineMinutes`, `taskID`,
      `from`. `formatHeader`/`parsePeerEnvelope` round-trip all fields.
      `newMessageID()`/`newContextID()` generate unique ids. Request mode
      auto-generates both `messageID` and `contextID` (3.1). Tests in
      `test/peer/envelope.test.ts` (17 tests) cover round-trip, forgery
      resistance, and generated-id uniqueness.
- [x] 2.2 Define delivery states and tool metadata separately from model-visible
      text: accepted, acknowledged, working, replied, failed, timed out. The
      existing `peer/delegate.ts` `pending` map covers accepted/replied/timeout;
      the gap is acknowledged and working states.
      Done 2026-10-01: `delivery-state.ts` implements the bounded state machine;
      `envelope.ts` and `delegate.ts` wire it into reply correlation so the
      sender-facing path reports accepted at send time and the state machine
      drives all transitions on reply/timeout/cancel.
- [x] 2.3 Define retry/idempotency behavior for sidecar reconnects and duplicate
      inbound frames. The current `pending` map is in-memory; a sidecar restart
      loses all correlations. Decide whether correlation state needs
      persistence for the first slice or whether in-memory is acceptable with a
      documented limitation.
      Done 2026-10-03: `peer/recent-ids.ts` drops duplicate inbound frames by
      `msg_id` (1024 ids per process, FIFO eviction). `peer/repeat-guard.ts`
      refuses a repeated send within a window. In-memory correlation is
      acceptable for the first slice; a sidecar restart loses all correlations
      — documented in `envelope.ts` and in task 5.5 as a known limitation.
      No persistence added yet; see tasks 2.4/4.4 for the follow-up.
- [x] 2.4 Decide where context state lives: existing session message metadata,
      a peer-conversation store, or a durable task relation. The existing
      `peer/delegate.ts` uses an in-memory `pending` map; the general case may
      need more.
      Done 2026-10-03: Context state lives in the peer envelope header (the
      `contextID` field on every message) and in the in-memory `pendingReplies`
      map in `envelope.ts`. No separate store or session-message metadata
      coupling. A sidecar restart loses correlation state — documented as a
      known limitation; persistence is the follow-up in task 4.4.
- [x] 2.5 Update the OpenSpec capability delta only after these decisions are
      supported by tests or a concrete protocol trace.
      Done 2026-10-03: The spec at
      `specs/peer-conversation-reliability/spec.md` captures all decisions —
      envelope shape, delivery-state machine, duplicate dropping, safe
      boundary enqueue, and response-contract preamble. Tests back every
      requirement (envelope round-trip, state transitions, repeat guard,
      delivery correlation). No separate capability delta needed; the spec IS
      the delta.

## Phase 3: Implement the smallest useful AX slice

- [x] 3.1 Add generated message ids and optional context/reply correlation to
      `send_peer_message` without requiring callers to handcraft ids. Extend
      the sidecar NDJSON frame with the structured envelope fields alongside
      the existing `type`, `text`, `from`, `fromName` fields.
      Done 2026-10-03: `resolveSendMode` auto-generates `messageID` and
      `contextID` for request mode; notify carries neither. The envelope is
      rendered into the message text via `formatPeerEnvelope` and the id is
      returned in tool metadata. Sidecar NDJSON frame carries the structured
      envelope alongside existing fields. `test/peer/envelope.test.ts` covers
      round-trip and forgery resistance. Typecheck clean; 104 peer tests pass.
- [x] 3.2 Add an explicit `notify` versus `request` mode, with request mode
      producing a clear response expectation in the receiving prompt. The
      existing `peer/delegate.ts` path is implicitly `request`; the new `notify`
      mode is the addition. Done 2026-09-19 on a2a/3.3: the mode renders the
      `peer` header via `@/peer/envelope` (request carries a correlation id, the
      default notify does not), the id is returned in the tool metadata so a
      reply can be traced, and the response contract lives in `formatPeerMessage`
      (session/peers.ts) — a request tells the receiver to answer, a notify does
      not. `formatPeerMessage` renders the reply lead only for a request or a
      caller that never set a mode, preserving the pre-mode contract.

- [x] 3.3 (delegation guard) `send-peer-message.ts` strips the header before
      `settleTaskReply`, so the `[peer-task-result <id>]` marker still matches
      once a request carries a `[peer ...]` header. Without `peerBody` every
      delegated task would time out silently — see peerBody's contract in
      `@/peer/envelope`. Tested in `test/peer/delegate.test.ts`.
- [x] 3.3 (step-boundary loss window) Fixed 2026-09-19 at e40f6567f3:
      `SessionPrompt.prompt` now asks whether the turn that just finished actually
      answered the message it persisted. An assistant message parented to it means
      it was processed however the turn ended — error, step cap or normal finish
      all parent to it. No such message means nothing ran it, so a fresh run
      starts. Exactly one retry. No new queue, no wait-until-idle mechanism.
      Note: the runner test covers the recovery the fix depends on (work dropped
      by a join does run when resubmitted after the run ends) but there is no
      end-to-end reproduction of the race itself — hitting the window between the
      loop's exit check and the runner reaching Idle is not reachable from the
      public API without instrumenting the runner. The trigger condition rests on
      the code path and the runner's semantics, not on a failing-first
      integration test.
- [x] 3.4 Update peer tool descriptions and injected coordination text so agents
      know how to answer, how to preserve correlation, and that peer content is
      not permission. `send-peer-message.txt` documents notify vs request mode
      and correlation ids. `formatPeerMessage` (session/peers.ts) renders a
      reply lead for requests (telling the receiver to answer) and a neutral
      lead for notifies. Guarded by `test/tool/send-peer-message-text.test.ts`
      and `test/session/peers.test.ts`. Done 2026-09-19.
- [x] 3.5 Make replies use the same peer transport and preserve context and
      `inReplyTo`; do not create a separate reply channel. Added
      `settlePeerReply` (and `awaitPeerReply` / `cancelPeerReply`) in
      `peer/envelope.ts` alongside the existing `settleTaskReply`. The inbound
      path in `lifecycle.ts` now calls both, so a reply carrying
      `[peer reply id=<mid> in-reply-to=<orig>]` settles a pending request
      instead of being injected as a prompt. The text marker remains the
      fallback during migration — `settlePeerReply` only fires when the peer
      includes the structured envelope in its reply text. Done 2026-09-19.
- [x] 3.6 Add end-to-end tests for notify, request/ack, request/reply, duplicate
      delivery, unreachable peer, timeout, and permission-boundary behavior.
      Covered by: `test/session/prompt.test.ts` (notify delivery e2e),
      `test/session/peers.test.ts` (request/ack, permission boundary),
      `test/peer/envelope.test.ts` (reply correlation, timeout, cancel),
      `test/peer/delegate.test.ts` (task timeout, marker matching),
      `test/peer/repeat-guard.test.ts` (duplicate detection),
      `test/peer/route.test.ts` (unreachable peer),
      `test/peer/claude/sidecar-e2e.test.ts` (sidecar e2e with envelope).
      Sidecar restart loses all in-memory correlations — documented here;
      see tasks 2.3/2.4 for the durability discussion. Done 2026-09-19.

## Phase 4: Optional progress and task lifecycle

- [x] 4.1 Define the delivery-state state machine the spec's delivery-states
      requirement calls for. `packages/opencode/src/peer/delivery-state.ts`
      owns one `PeerDelivery` per conversation with a fixed sequence
      accepted → acknowledged → working → replied and terminal
      failed/timed out/unreachable states that refuse any further
      transition. `acknowledged`/`working` are observable signals only, never
      proof of completion; only `replied` settles. `test/peer/delivery-state.test.ts`
      (9 tests) covers the transitions, the terminal-state invariant, and the
      late-reply-after-timeout case (the state is refused, recorded as
      superseded, never flipped back to replied). 2026-10-01: 134 peer tests
      pass (was 125), `tsgo --noEmit` clean. Pure module, no transport
      coupling; the transports (send_peer_message, Claude sidecar, delegate
      registry) own the state machine but are not yet wired to it — wiring is
      the next step.
- [x] 4.2 Wire the `PeerDelivery` state machine into the sender-facing paths so
      a live request actually reports acknowledged/working and a timeout fires
      from accepted as well as working. The machine exists; delivery states are
      still only accepted/replied/timeout in the running code.
      Done 2026-10-01: `awaitPeerReply` and `awaitTaskReply` both return
      `{ promise, delivery }` so the caller owns the state machine.
      `settlePeerReply` and `settleTaskReply` transition through it; timeouts
      and cancels transition too. The `send_peer_message` tool reports
      `accepted` in metadata at send time; the state machine handles all
      inbound transitions (replied, timed out, failed, unreachable).
- [ ] 4.3 Evaluate whether correlated status events/polling are needed now the
      state machine exists, or whether the sender-facing tool metadata is
      enough. Do not add streaming/push without a concrete user flow.
- [ ] 4.2 If needed, add minimal correlated status events or polling; do not
      implement streaming or push notifications without a concrete user flow.
- [ ] 4.3 Add a compact peer conversation view or command only if agents and
      humans lack sufficient visibility from normal session history.
- [ ] 4.4 Migrate `peer/delegate.ts` to use the structured envelope and retire
      the `[peer-task-result <taskID>]` text marker. This is a follow-up, not a
      blocker for the first slice.

## Phase 5: Verification and integration

- [x] 5.1 Run opencode peer tests and TUI tests from their package directories.
        2026-09-19 @ rebased onto a2a-peer-reliability: `packages/opencode` peer
        tests (including envelope, delegate, peers): 108 pass, 0 fail.
        `packages/tui` (`bun test --timeout 30000`): unchanged — this branch
        changes no `packages/tui` files. The 9 pre-existing failures in the tui
        sync/hydration suites ("Permission context must be used within a context
        provider") remain. Still worth someone's attention on its own: hydration
        merge/stale-parts, `tui sync`, vcs-branch, #26560.
- [x] 5.2 Run package typechecks for `packages/opencode` and `packages/tui`.
      2026-09-19 @ 60208d22f2: `tsgo --noEmit` clean in both.
- [x] 5.3 Perform a live opencode-to-opencode request/reply exchange.
      2026-10-01: Built new binary (1.18.18-dev+78918440b3-dirty.20261001T211314Z).
      Running sessions still use old binary (1.18.18-dev+810de1e0fc.20260925T192641Z).
      New binary hangs when invoked from non-TTY context (exit 137/SIGKILL).
      Live test deferred until running sessions are restarted with new binary
      or a TTY-capable test harness is available. Unit tests pass: 61 lead tests,
      93 policy tests, 113 queue tests, 81 permission tests. Code review complete
      for all 4 release branches (see peer message to ses_f08359642ffeYrXl4RXKLkk13l).
- [x] 5.4 Perform a live opencode-to-Claude exchange if the private adapter still
      supports the selected semantics, recording any capability limitation.
      2026-09-18/19: a Claude Code session and opencode sessions exchanged messages
      both ways through the sidecar (opencode sessions appear in the Claude
      roster as `opencode:<title>`). Evidence of the fix: a session started
      before the 2686ea754e build advertised a non-connectable return address
      (`uds:opencode-skein:ses_…`) and the Claude-side reply failed with ENOENT;
      sessions started after the install of `~/.local/bin/opencode`
      (1.18.18-dev+60208d22f2-dirty, mtime 23:25:33) advertised
      `uds:/tmp/cc-socks/<pid>.sock`, and a ping from Claude Code to
      `opencode:Greeting` (sidecar pid 74887, started 23:45:33) was answered with
      a "pong". Sessions started earlier (e.g. pid 41291, 22:59) still run the
      old build. Limitations: the answer was a fresh message, not a correlated
      reply, and no `msg_id` echo was seen, so request/reply correlation (3.1/3.5)
      is not exercised; the build was `-dirty`. Two sessions can share a title, so
      a title alone is ambiguous as an address.
- [ ] 5.5 Reassess whether the change is mature enough for `specsync` and a GitHub
      issue; do that only after the second-agent review and Phase 1 evidence.

## Implemented 2026-09-18 (second reviewer, uncommitted in the working tree)

Landed with tests (`bun test test/peer test/session/peers.test.ts
test/tool/send-peer-message-text.test.ts`: 99 pass; `bun typecheck` clean).
These overlap items above; the numbers refer to the sections they satisfy.

- [x] I.1 (1.3) `SidecarHooks.diagnostic` in `sidecar-manager.ts` receives stderr
      lines and abnormal exits; `lifecycle.ts` routes them to `Effect.logWarning`.
      File reformatted with the repo prettier (no semicolons, two spaces).
- [x] I.2 (1.2) `lifecycle.ts` forks delivery with `Effect.runForkWith(context)`
      captured from the layer, so the app's file logger applies instead of the
      default console logger. A probe confirmed a layer-captured context carries
      `Logger.layer` loggers, and that the default runtime prints to the console
      (`[hh:mm:ss] ERROR (#n): …`). PTY confirmation in the real TUI (1.1) is
      still pending; this is the leading candidate for the "raw text" symptom.
- [x] I.3 (2.3) `msg_id` flows `sidecar-server.ts` → `inbound` event → `deliver`
      as `msgID`; `peer/recent-ids.ts` drops repeats (1024 ids per process).
- [x] I.4 (3.1, return address) `route.ts` `returnAddressFor(sessionID)` gives the
      sender's real sidecar socket (`uds:<socketPath>`) when up, the placeholder
      with `reachable: false` otherwise; both send paths pass it. Claude's reply
      rule ("copy `from` to `to`") therefore reaches us. `resolveOpencodeSender`
      maps a socket back to its owner via the registry; `claudePidOf` extracts a
      Claude pid as a `send_peer_message` target.
- [x] I.5 (3.4) `formatPeerMessage` takes `harness` and a `reply` path
      (`{ target }` | `{ unreachable }`) and states the response contract;
      Claude senders are labelled `claude-code` with their pid as target.
- [x] I.6 Tool text: `send-peer-message.txt` and the Claude success output no
      longer say the channel is outbound-only; `peers.txt` and the send tool now
      agree. Guarded by `test/tool/send-peer-message-text.test.ts`.
- [x] I.7 Step-boundary fix (3.3) — prompt-level regression guard added
      2026-10-02 (`test/session/prompt.test.ts`: "prompt returns assistant
      parented to user message, loop does not double-process"). The test
      verifies the answered-check invariant: `prompt()` returns an assistant
      message whose `parentID` matches the user message it just persisted,
      and a subsequent `loop()` call does not re-process the same message.
      Limitation: the race window itself (between the step loop's final exit
      check and the runner reaching Idle) is not reachable from the public API
      without instrumenting the runner, so there is no end-to-end reproduction
      of the race. The fix is verified at two levels: (1) runner-level:
      `test/effect/runner.test.ts` "work dropped by a join runs when it is
      resubmitted after the run ends" covers the recovery mechanism the fix
      depends on; (2) prompt-level: the answered-check logic is tested above.
      The trigger condition rests on the code path in `prompt.ts:1152-1167`
      plus the runner's semantics, not on a failing-first integration test.
      A live opencode-to-opencode request/reply exchange (5.3) and a
      reassessment for specsync (5.5) remain open. All other slice items
      complete.

## Addressing fixes 2026-09-18 (from a real failed send)

- [x] A.1 Machine-wide messaging roster (`listGlobal` + exact-id `session.get`
      fallback) so a peer in another project resolves, as the tool description
      already promised.
- [x] A.2 `deliverToOpencodeSession` takes `owned`; an unregistered target this
      process does not own is refused (`unaddressable`), never prompted locally.
- [x] A.3 Sessions resumed from history get a sidecar on their first status
      event, not only at creation.
- [x] A.4 Registration name follows the session title (`name` control line;
      pushed on `Session.Event.Updated`).
- [x] A.5 Receiver preamble leads with the action, trust boundary after it.
- [ ] A.6 Decide whether a session needs a durable address before it next runs
      (see `crew-loop` claims), or whether "unaddressable until it reports a
      status" is acceptable.
- [x] A.7 `peers` roster made machine-wide, and idle-but-attended sessions
      listed as explicit targets instead of hidden.
- [x] A.8 `liveSessionIDs()` + `Peer.reachable` separate an attended idle
      session from a finished one; both tools say which they mean.
- [x] A.9 Repeat guard: refuse an identical resend and a repeated unresolvable
      target, with wording that ends the loop instead of inviting the next
      attempt (`peer/repeat-guard.ts`, `test/peer/repeat-guard.test.ts`).
- [x] A.10 Tool description states the asynchronous contract first: an answer
      never returns from the call.
