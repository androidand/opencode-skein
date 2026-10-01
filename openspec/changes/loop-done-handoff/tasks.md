# Tasks: loop done is a handoff

## Phase 0: Reproduce

- [ ] 0.1 Failing tests for the three shapes in `autonomous-swarm` 0.3: prompt-mode token with
      more work on the board, `--no-eternal`, drained queue — each asserts the loop is NOT
      terminal and a notice was sent. Each must be seen red on current code first.
- [ ] 0.2 Failing test: a prompt-mode token with unchecked tasks of the attached change is
      currently accepted.

## Phase 1: State and pipeline

- [ ] 1.1 Add `idle-watch` to the loop `Status` schema and TUI labels; not a stall; backoff
      reused from `crew-loop` 3.3 (coordinate, do not duplicate).
- [ ] 1.2 Done pipeline in `loop.ts`: verify → review hook point → record → notify → release →
      next → idle-watch.
- [ ] 1.3 Wake sources: inbox message, board change, lead directive, persisted timer.

## Phase 2: Evidence

- [ ] 2.1 Reject token with unchecked tasks or red gate when a slug is attached; continue with
      a brief naming what is missing.
- [ ] 2.2 `--once` opt-in for a bounded run; default unchanged otherwise per eternal-by-default.

## Phase 3: Notices and delegation

- [ ] 3.1 Completion notice via the existing envelope; one per completion (repeat-guard test).
- [ ] 3.2 Slug-bearing delegation from a granted lead starts a queue-mode loop, acks, notifies
      at the end; delegation from a non-lead keeps today's behaviour.
- [ ] 3.3 Lead brief lists recent completions.

## Phase 4: Live

- [ ] 4.1 Member finishes change A with change B waiting: continues to B, lead sees one notice.
- [ ] 4.2 Empty board: member enters idle-watch, sends nothing, wakes on a new change.
