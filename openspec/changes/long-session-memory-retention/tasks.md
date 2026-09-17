# Tasks: long-session-memory-retention

## Phase 0: Find the cause, not the issue title

- [x] 0.1 Check each diagnosed upstream cause against this codebase (#35107, #34574, #45215,
      #38362) — see `proposal.md` for what was and was not present
- [x] 0.2 Check the user's real logs for the #34574 signature — zero hits in 12 files
- [x] 0.3 Measure whether freed memory returns to the OS on this Bun — it does (175→57 MB
      after 2 s idle); an allocator knob made it worse; growth is therefore live retention
- [x] 0.4 Locate the unbounded retainers — rendered transcript (TUI, primary) and SSE
      subscriber queue (server, HTTP clients)

## Phase 1: Fix

- [x] 1.1 Transcript windowing: `CollapsedMessage` for messages older than
      `RECENT_MESSAGE_WINDOW`, per-item expand state, id preserved for prompt navigation
- [x] 1.2 Bound the SSE subscriber queue with `EventV2.allBounded`, capacity 10,000
- [x] 1.3 `updatePart`: shallow copy instead of `structuredClone`, `sessionID` preserved
- [x] 1.4 Reasoning header: static while open, spinner only while collapsed
- [x] 1.5 Register all edited upstream files in `fork/manifest.json` with markers
- [x] 1.6 Make the window configurable the idiomatic way: `transcript_window` in the TUI
      config schema (`TranscriptWindow` + `TranscriptWindowDefault`, like `LeaderTimeout`),
      read via `useTuiConfig()` like `scroll_speed`; `0` never collapses. No migration entry
      needed (that file maps legacy keys only).

## Phase 2: Verify

- [x] 2.1 `bun typecheck` clean in `packages/opencode` and `packages/tui`
- [x] 2.2 `packages/opencode` session suite green (a first run's 138 failures were my own
      dropped `sessionID` field, fixed; one subsequent failure did not reproduce — flaky).
      `packages/tui` suite: 209 pass, 9 pre-existing failures, all in the sync-store and
      diff-viewer test harnesses ("Permission context must be used within a context
      provider"), none of which import the session route or anything changed here.
- [x] 2.3a Rebuilt: `1.18.18-dev+e3bfe849f7-dirty.20260917T223143Z` (includes
      `transcript_window`)
- [ ] 2.3b Use the TUI: old messages collapse past 40 and show a one-line summary, click
      expands one and it stays open, prompt navigation still lands on user prompts, no
      spinner shake while an expanded thinking block is streaming
- [ ] 2.4 The real proof: RSS sampled over a multi-hour session before vs. after, with
      `OPENCODE_AUTO_HEAP_SNAPSHOT=true` so a crash leaves a heap snapshot next time
