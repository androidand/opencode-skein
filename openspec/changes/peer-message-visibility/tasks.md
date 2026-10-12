# Tasks: peer message visibility and tool robustness

Decisions (Andreas, 2026-10-12): robustness in this change; dedicated `peer-message`
part; surfaces = TUI, web app, session-ui, CLI run mode; keep it simple and evidence-based.
Each phase can ship or be dropped on its own.

## Phase 1: Part type and model path

- [ ] 1.1 Add `PeerMessagePart` to the Part union in `session/message-v2.ts`
      (`session/message.ts` is a different schema).
- [ ] 1.2 Test first: a session with a peer-message part converts to the same model text
      as the old synthetic injection. Watch it fail, then add the branch in
      `toModelMessages`.
- [ ] 1.3 Guard test: every Part type is converted or declared UI-only; confirm it fails
      for an undeclared type.
- [ ] 1.4 Inventory every Part consumer (`part.type`, `.synthetic`) in `opencode`, `core`,
      `tui`, `app`, `session-ui`, `sdk`; record each here as handled or N/A.
- [ ] 1.5 Find the generator of the SDK `Part` types and regenerate. Not
      `tui/src/local/llama-skein/gen/` (llama-skein API, no Part types).

## Phase 2: Producers

- [ ] 2.1 Emit the part from `peer/claude/lifecycle.ts` and `send-peer-message.ts`
      `runLocal` using `parsePeerEnvelope`; synthetic text when it does not parse.
- [ ] 2.2 Queued drains produce the same part. Test: direct and drained deliveries match.
- [ ] 2.3 Decide how the wrapping user message renders (no empty user turn).

## Phase 3: Rendering

- [ ] 3.1 TUI: `routes/session/index.tsx` (~395, 677, 882, 1495), `util/transcript.ts`,
      `context/data.tsx`.
- [ ] 3.2 Web app: `app/src/utils/session-message.ts`, `pages/session/timeline/rows.ts`.
- [ ] 3.3 session-ui: `components/message-part.tsx`.
- [ ] 3.4 CLI run: `cli/cmd/run/session.shared.ts`, `session-replay.ts`.
- [ ] 3.5 For each synthetic check, decide include/exclude explicitly and test it.

## Phase 4: `peers` in bash

- [ ] 4.1 Test first: `peers`, `rtk peers 2>&1 | head`, `opencode peers --json` return the
      pointer and run nothing; `grep peers x` runs.
- [ ] 4.2 Implement the intercept.

## Phase 5: Descriptions

- [ ] 5.1 Rewrite `send-peer-message.txt` and `peers.txt`: contract line, example call,
      then incident rules, compressed. Not longer than today (4.2 KB and 4.5 KB).
- [ ] 5.2 Test that the retained rules are still present.

## Phase 6: Verification

- [ ] 6.1 Every fix above has a test that goes red without it.
- [ ] 6.2 `peer-conversation-reliability` tests still pass.
- [ ] 6.3 Send a real message to a live session and see the block on each surface.
- [ ] 6.4 State what is not covered.

## Deferred, not dropped

Text-form tool calls (1 observation), repeat-guard changes, delivery-result wording
(already fixed 2026-09-19), whether the `peers` tool was in the weak model's toolset.
