# Tasks: peer message visibility and tool robustness

Decisions (Andreas, 2026-10-12): robustness in this change; dedicated `peer-message`
part; surfaces = TUI, web app, session-ui, CLI run mode; keep it simple and evidence-based.
Each phase can ship or be dropped on its own.

## Phase 1: Part type and model path

- [x] 1.1 `PeerMessagePart` + `PeerMessagePartInput` in the Part union, `packages/schema/src/v1/session.ts`
      (not message-v2.ts / message.ts; the field is `envelopeID` because `messageID` is the part's own).
- [x] 1.2 Test first: a session with a peer-message part converts to the same model text
      as the old synthetic injection. Watch it fail, then add the branch in
      `toModelMessages`.
- [x] 1.3 Guard test: every Part type is converted or declared UI-only; confirm it fails
      for an undeclared type.
- [x] 1.4 Consumers: model conversion (handled), title generation (`isTypedUserMessage`, handled),
      TUI input counter / edit-last / visible list (N/A: they match `type === "text"` only),
      TUI block + transcript (handled), session-ui user message (handled), web timeline rows (N/A:
      one row per user message), CLI run live stream (handled), run history replay and the v2
      `session.next.synthetic` event path (NOT covered, see below).
- [x] 1.5 Regenerated `packages/sdk/js/src/v2/gen` and `packages/sdk/openapi.json` (the latter was
      already stale: Gallery API). Not `tui/src/local/llama-skein/gen/` (llama-skein API).

## Phase 2: Producers

- [x] 2.1 `peerMessagePart()` in `session/peers.ts`, used by `lifecycle.ts`, `send-peer-message.ts` and
      `task.ts` (delegation). No synthetic fallback: the channel decides.
- [x] 2.2 Queued drains produce the same part. Test: direct and drained deliveries match.
- [x] 2.3 TUI/web render the peer block and no empty user bubble; run mode commits one entry.

## Phase 3: Rendering

- [x] 3.1 TUI: `routes/session/index.tsx` (~395, 677, 882, 1495), `util/transcript.ts`,
      `context/data.tsx`.
- [x] 3.2 Web app: `app/src/utils/session-message.ts`, `pages/session/timeline/rows.ts`.
- [x] 3.3 session-ui: `components/message-part.tsx`.
- [x] 3.4 CLI run live stream (`session-data.ts`); `session-replay.ts` not changed.
- [x] 3.5 For each synthetic check, decide include/exclude explicitly and test it.

## Phase 4: `peers` in bash

- [x] 4.1 Test first: `peers`, `rtk peers 2>&1 | head`, `opencode peers --json` return the
      pointer and run nothing; `grep peers x` runs.
- [x] 4.2 Implement the intercept.

## Phase 5: Descriptions

- [x] 5.1 Rewrite `send-peer-message.txt` and `peers.txt`: contract line, example call,
      then incident rules, compressed. Not longer than today (4.2 KB and 4.5 KB).
- [x] 5.2 Test that the retained rules are still present.

## Phase 6: Verification

- [x] 6.1 Every fix above has a test that goes red without it.
- [x] 6.2 `peer-conversation-reliability` tests still pass.
- [ ] 6.3 Send a real message to a live session and see the block on each surface
      (needs a build deployed to the running instances; not done).
- [x] 6.4 Not covered: rendering was never looked at in a running TUI/browser (type-checked and
      tested at the data level only); `session-replay.ts` history replay; the experimental v2 event
      path (`OPENCODE_EXPERIMENTAL_EVENT_SYSTEM`, off here), where peer text no longer dual-writes
      as `SessionEvent.Synthetic`; local `send_peer_message` to an owned session carries no envelope
      id in its model text (pre-existing). Pre-existing failures: two `preserves metadata after
      tool-call transition` tests and `tui thread > routes attached sessions to mini mode`.

## Deferred, not dropped

Text-form tool calls (1 observation), repeat-guard changes, delivery-result wording
(already fixed 2026-09-19), whether the `peers` tool was in the weak model's toolset.
