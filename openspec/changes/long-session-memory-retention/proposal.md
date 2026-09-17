# Stop a long-running session from growing until the machine dies

## Why

A long-running opencode-skein TUI session grows in memory until macOS kills the machine —
the user's M3 Mac has been taken down by OOM several times. Upstream has ~20 open OOM/leak
issues and has fixed none of them since this fork's baseline; the fork had already bounded
one growth vector (`session-summary-write-amplification`) and has an event-journal retention
sweep, but the process itself still climbs.

## What was actually found (2026-09-18)

Investigated against this codebase and this machine, not from the issue titles:

- **Not the cause here — upstream #35107's per-token `structuredClone(part)`.** Our processor
  publishes a small `PartDelta` per token for both text and reasoning; the full-part
  `updatePart` (with the clone) fires only at part start/end and tool state changes. O(parts),
  not O(tokens²).
- **Not the cause here — upstream #34574's Effect `EventTarget` listener leak.** Zero
  `MaxListenersExceededWarning` hits across all 12 of the user's real log files.
- **Not the cause here — "Bun never returns freed pages."** Measured: streaming-shaped churn
  took RSS 76→175 MB; after release and 2 s idle it fell to 57 MB. Memory does return on this
  Bun. An allocator env knob made it *worse*. So a real long-session climb is **live
  retention**, not unreturned pages — which is what made the remaining candidates decisive.
- **Not the cause — sync-store bookkeeping** (`syncingSessions`/`hydratingSessions` are deleted
  on completion) and the worker→TUI event forwarding (one `Rpc.emit` per event, no queue).
- **Real, TUI side — the unbounded rendered transcript.** `<scrollbox><For each={messages()}>`
  with no windowing: every message and every part of the session stays mounted as rendered
  nodes — markdown, syntax highlighting, code blocks, and the hundreds-of-KB reasoning dumps
  local/reasoning models produce — for the session's whole life. The TUI is one process (its
  server is a Worker thread), so this and the server-side growth land in the same PID. The
  user's DB holds 91,569 parts / 231 MB of raw part text; rendered trees are far larger than
  raw text. This is the one unbounded retainer left standing and the primary fix.
- **Real, server side — the unbounded per-subscriber SSE queue** (`handlers/event.ts`,
  `Queue.unbounded` + `offerUnsafe` for every event before filtering; upstream #45215). It
  affects HTTP clients (web/desktop), not the default TUI's worker-RPC feed, but a stalled
  client retains every event in the process forever.

## What Changes

1. **Transcript windowing** (`packages/tui/src/routes/session/index.tsx`): messages older than
   the most recent `RECENT_MESSAGE_WINDOW` (40) render as a one-line `CollapsedMessage`
   placeholder until clicked. Because Solid disposes the losing `Match` branch, old messages'
   heavy renderers are unmounted, not hidden. The transcript stays fully scrollable; keyboard
   prompt-navigation keeps working (placeholders carry the message id exactly where
   `UserMessage` does); a message the user opens stays open.
2. **Bounded SSE subscriber queue** (`handlers/event.ts`): `EventV2.allBounded` (core's
   existing dropping-queue pattern) with capacity 10,000; on overflow the stream fails and the
   client reconnects and resyncs — the recoverable outcome.
3. **Shallow part copy in `updatePart`** (`session/session.ts`): `{ ...part }` instead of
   `structuredClone(part)`. Same snapshot for the in-place-mutated `text` field (strings are
   immutable; `+=` reassigns), without copying part bytes per publish. Safe: every consumer
   destructures synchronously (projector), clones for itself (`share-next`), or receives an
   already-serialized copy (SDK/SSE). Minor in this fork; kept because it is strictly cheaper
   and upstream-validated.
4. **Reasoning spinner shake** (same TUI file, unrelated to memory, user-reported alongside):
   the animated `Spinner` re-laid out the expanded reasoning body every frame. Static header
   while open, spinner only while collapsed.

## Non-Goals

- No pruning of the event journal — the fork's `EventRetention` sweep already does that.
- No allocator tuning — measured not to help here.
- No fix for upstream #34574 — its signature is absent on this machine.

## Open

- The primary fix is verified by typecheck and the existing suites, **not yet by a measured
  multi-hour session**. The honest proof is RSS over a long real session before/after. The
  fork's `OPENCODE_AUTO_HEAP_SNAPSHOT` tool (heap snapshot when RSS > 2 GB) was never enabled
  during the crashes, so no snapshot exists; it should be on for the next long session.
- ~~`RECENT_MESSAGE_WINDOW` is a constant~~ — now the `transcript_window` TUI config key
  (`packages/tui/src/config/index.tsx`, default 40, `0` never collapses), read through
  `useTuiConfig()` exactly like `scroll_speed`. Set it in `.opencode/tui.json`.
- The sync store already caps *hydration* to a 100-message window (its own tests say so), but
  a *live* session appends to `store.message[sessionID]`/`store.part[...]` without a cap. Raw
  message and part data is far smaller than rendered nodes, so this is second-order — but for
  a truly marathon session it is the next unbounded thing, and capping live retention to the
  same window is the natural follow-up.
