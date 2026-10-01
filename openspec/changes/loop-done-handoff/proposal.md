# Loop done is a handoff, not an exit

Parent: `autonomous-swarm` (F3).

## Why

When a session emits its completion signal, the run ends and nothing else happens: no one
is told, nothing is reviewed, nothing picks up the next item. In `loop/loop.ts` a completion
token finalizes a prompt-mode loop as `completed` (~L632) and a drained queue calls
`finishQueue(…, "completed", …)` (~L1168). `loop-eternal-by-default` routes an eternal plain
loop into queue mode, which helps, but the drained-queue end is still terminal and silent,
and in a crew the finishing member's completion is invisible to the lead and to the others.

Which exact shape the operator hit ("emit a done task and it halts everything") is not yet
reproduced; `autonomous-swarm` Phase 0.3 does that first.

Also relevant: the completion token is the model's own word. A 35B local model declared
COMPLETE on iteration 1 of 50 (2026-09-20). Queue mode already verifies against `tasks.md`;
prompt mode has no ground truth.

## What Changes

1. **Done runs a pipeline** (epic D4): verify evidence → trigger `review-on-done` → record
   the verdict → send one `notify` to the lead (and the delegating peer, if any) → release the
   claim → pick the next eligible item → else enter `idle-watch`.
2. **`idle-watch`**: a non-terminal loop state with backoff, woken by inbox messages, board
   changes (new/changed `openspec/changes/*`, released claims) and a new lead directive.
   Reuses `crew-loop` 3.3 (empty-board backoff) so there is one implementation. Not counted
   as a stall.
3. **Terminal states narrowed** to: user cancel, error, explicit operator stop, and an
   opt-in bounded prompt-mode `--once`. A drained queue enters `idle-watch` rather than
   `completed` unless `--once`.
4. **Evidence for the token**: in spec-backed work, a completion token with unchecked tasks
   or a failing gate is rejected and the loop continues (extends the existing "verified
   completion" stance of queue mode to prompt mode when a change slug is attached).
5. **Companion (from the conductor plan)**: a slug-bearing delegation from the granted lead
   starts a queue-mode loop for that slug, acknowledges immediately, and sends one completion
   notice at the end. Implemented here, on top of `crew-loop` Phase 2/3.
6. **Completion notice schema**: `{slug, branch, headSHA, gates, reviewVerdict?}` carried in
   the existing envelope; the lead's brief lists recent completions.

Depends on durable loop records (`project-server` Phase 2) for `idle-watch` to survive a
restart; until then `idle-watch` is per process.

## Non-goals

- No change to cancel/error semantics.
- No guessing the next item for a plain session with no board; it reports and waits (quietly,
  with the wake sources above), as an honest outcome.

## Impact

`loop/loop.ts` (completion and queue-drained paths, new state), `loop/spec-queue/*`,
`loop/completion.ts`, `peer/delegate.ts` (ack + notice), `crew-loop` brief, TUI state label,
tests.
