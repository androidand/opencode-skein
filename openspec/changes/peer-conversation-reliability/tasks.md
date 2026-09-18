# Tasks: peer conversation reliability

## Phase 0: Review and guardrails

- [x] 0.1 Have a second agent review `proposal.md`, `design.md`, and
      `findings.md`, specifically challenging the TUI root-cause hypothesis and
      the proposed envelope fields. (Done 2026-09-18: review identified the
      `peer/delegate.ts` omission, the stderr-discard gap, the unsafe
      `startImmediately: true` fork, and the fragile text-marker correlation.
      All four findings incorporated into the updated spec.)
- [ ] 0.2 Keep this change local until the review identifies a bounded first
      implementation slice. Do not run specsync against GitHub yet.
- [ ] 0.3 Decide whether the existing Claude private protocol should remain an
      adapter detail or whether a transport-neutral envelope is required at the
      sidecar boundary. (Leaning: structured envelope at the sidecar NDJSON
      boundary, with the Claude private protocol remaining an adapter detail
      behind `sidecar-manager.ts`.)

## Phase 1: Reproduce and close the TUI corruption

- [x] 1.1 Build a PTY reproduction that starts the TUI, injects an inbound peer
        message, captures stdout/stderr bytes, and records terminal dimensions.
        Done 2026-09-19 (restructured 2026-09-19): `packages/opencode/test/peer/claude/pty-repro.test.ts`.
        Three parts: (1) positive control — spawns a subprocess that deliberately
        forks on the default runtime and asserts the leak reaches the pipe,
        proving the harness works; (2) regression — spawns a subprocess that
        forks through `runForkWith(appContext)` and asserts stdout is clean,
        proving the mechanism matters; (3) source-level guard — asserts
        `lifecycle.ts` contains `Effect.runForkWith(` and no bare
        `Effect.runFork(`, closing the gap between "the technique works" and
        "the module uses it". Capture is at the subprocess-pipe level throughout,
        not by patching process.stdout.write, because Effect writes directly to
        the fd.
- [x] 1.2 Verify whether any raw JSON or sidecar diagnostic bytes bypass
        OpenTUI. The NDJSON part is always true (parent consumes both child
        pipes). The diagnostics half runs through the same fork path as 1.1 and
        is covered by the source-level guard (lifecycle.ts uses
        runForkWith). The sidecar deliver cycle test in pty-repro.test.ts still
        asserts no raw JSON/diagnostic leakage. Done 2026-09-19.
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

- [ ] 2.1 Decide and document the minimum envelope: message id, sender,
      recipient, mode, context id, reply correlation, and response expectation.
      The envelope generalizes `peer/delegate.ts`; see `design.md` for the
      proposed shape and the migration path from the text marker.
- [ ] 2.2 Define delivery states and tool metadata separately from model-visible
      text: accepted, acknowledged, working, replied, failed, timed out. The
      existing `peer/delegate.ts` `pending` map covers accepted/replied/timeout;
      the gap is acknowledged and working states.
- [ ] 2.3 Define retry/idempotency behavior for sidecar reconnects and duplicate
      inbound frames. The current `pending` map is in-memory; a sidecar restart
      loses all correlations. Decide whether correlation state needs
      persistence for the first slice or whether in-memory is acceptable with a
      documented limitation.
- [ ] 2.4 Decide where context state lives: existing session message metadata,
      a peer-conversation store, or a durable task relation. The existing
      `peer/delegate.ts` uses an in-memory `pending` map; the general case may
      need more.
- [ ] 2.5 Update the OpenSpec capability delta only after these decisions are
      supported by tests or a concrete protocol trace.

## Phase 3: Implement the smallest useful AX slice

- [ ] 3.1 Add generated message ids and optional context/reply correlation to
      `send_peer_message` without requiring callers to handcraft ids. Extend
      the sidecar NDJSON frame with the structured envelope fields alongside
      the existing `type`, `text`, `from`, `fromName` fields.
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
- [ ] 3.3 (step-boundary loss window) The remaining half — changing the
      `local()` closure from
      `ops.prompt(...).pipe(Effect.forkIn(scope, { startImmediately: true }))`
      to a safe-boundary enqueue — needs the runner/core safe-boundary enqueue
      that `steer-running-work` and design.md point to. That lives in the runner
      (`packages/core`/`effect/runner.ts`), which is the lead's 3.5/runner work,
      not in `tool/send-peer-message.ts`. Left for the lead's slice; the
      delegation-guard half above is complete and green.
- [ ] 3.4 Update peer tool descriptions and injected coordination text so agents
      know how to answer, how to preserve correlation, and that peer content is
      not permission. The existing `formatPeerMessage` in `peers.ts:279-294`
      already states the permission boundary; extend it with mode, context id,
      and response expectation.
- [ ] 3.5 Make replies use the same peer transport and preserve context and
      `inReplyTo`; do not create a separate reply channel. Extend
      `settleTaskReply` (or add `settlePeerReply`) to match structured envelope
      replies alongside the existing `[peer-task-result <taskID>]` text marker.
      Keep the text marker as a fallback during migration.
- [ ] 3.6 Add end-to-end tests for notify, request/ack, request/reply, duplicate
      delivery, unreachable peer, timeout, and permission-boundary behavior.
      Include a test that a sidecar restart does not silently lose a pending
      correlation (or documents that it does, if in-memory is the accepted
      limitation for the first slice).

## Phase 4: Optional progress and task lifecycle

- [ ] 4.1 Evaluate whether working/progress/failure status is needed after the
      request/reply slice is live.
- [ ] 4.2 If needed, add minimal correlated status events or polling; do not
      implement streaming or push notifications without a concrete user flow.
- [ ] 4.3 Add a compact peer conversation view or command only if agents and
      humans lack sufficient visibility from normal session history.
- [ ] 4.4 Migrate `peer/delegate.ts` to use the structured envelope and retire
      the `[peer-task-result <taskID>]` text marker. This is a follow-up, not a
      blocker for the first slice.

## Phase 5: Verification and integration

- [x] 5.1 Run opencode peer tests and TUI tests from their package directories.
      2026-09-19 @ 60208d22f2: `packages/opencode` peer + session/peers + tool +
      util/git-branch + local/ctx-fit tests (a subset; a wider run of provider,
      local, peer, session, tool and util is reported at 1901 by the A2A AX spec
      review session, unverified here): 144 pass, 0 fail. `packages/tui`
      (`bun test --timeout 30000`): 209 pass, 9 fail, all "Permission context must
      be used within a context provider" in the sync/hydration suites. This branch
      changes no `packages/tui` files. The 9 failures are pre-existing, by
      inference and not by a run at `dev`: `git diff --name-only fe56a6b331..HEAD`
      touches only `packages/opencode` (27 files), and `packages/tui` imports only
      `@opencode-ai/{sdk/v2,plugin/tui,core,ui}`, none of which changed. Still
      worth someone's attention on its own: "Permission context must be used
      within a context provider" in the tui sync/hydration suites (hydration
      merge/stale-parts, `tui sync`, vcs-branch, #26560).
- [x] 5.2 Run package typechecks for `packages/opencode` and `packages/tui`.
      2026-09-19 @ 60208d22f2: `tsgo --noEmit` clean in both.
- [ ] 5.3 Perform a live opencode-to-opencode request/reply exchange.
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
- [ ] I.7 Still open from this slice: `mode`/`context` parameters (3.1–3.2),
      the step-boundary fix (3.3 — note the race is `prompt()` persisting the
      message and then `Runner.ensureRunning` joining a run that already passed
      its exit check, see `findings.md` "Busy handling"; the fork is not itself
      the hazard), the PTY reproduction (1.1), and a live Claude reply
      round-trip (5.4).

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
