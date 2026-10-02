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

## Existing invariants every new driver path must respect

Reported by a peer review and verified in `loop.ts` ~1514–1542:

1. **One queue-shaped driver per directory.** `QueueActiveError` at creation and the guard
   in `runPromptThenMaybeQueue` exist because two queue drivers would fight over one derived
   cursor and one working tree. Every path this change adds that starts or continues a
   queue-shaped loop (the done pipeline's "pick next", a lead-delegated slug) MUST pass the
   same check, implemented once as a shared function, not copied per path. With a project
   server and crew claims the unit of exclusion becomes the claim (one live claim per
   change, one worktree per claim) and the directory rule applies per worktree.
2. **Resurrection requires `eternal`** (L1520).
3. **Resurrection requires an eligible backlog** (L1523: `resolveQueue(...).eligible`).
   `idle-watch` is the new behaviour for the empty case and must not bypass 1 or 2 for loops
   that opted out with `--once` / `--no-eternal`.

A test per entry point asserts the invariant: a second driver-creating path in an occupied
directory is refused (seen red with the guard removed).

## Dependency order

"Release the claim" and the claim-based exclusion need the `claims` table
(`crew-loop` Phase 1, branch `crew-loop/claims`, unmerged). Until it lands, the done
pipeline records the outcome and notifies but has no claim to release, and the directory
guard remains the only exclusion. Tasks 1.2 and 3.2 are ordered after `crew-loop` 1.1–1.3
for the claim parts.

## Non-goals

- No change to cancel/error semantics.
- No guessing the next item for a plain session with no board; it reports and waits (quietly,
  with the wake sources above), as an honest outcome.

## Impact

`loop/loop.ts` (completion and queue-drained paths, new state), `loop/spec-queue/*`,
`loop/completion.ts`, `peer/delegate.ts` (ack + notice), `crew-loop` brief, TUI state label,
tests.
