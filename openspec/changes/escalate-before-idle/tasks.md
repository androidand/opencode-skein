# Tasks: escalate before idle

## Phase 0: Corpus and baseline

- [ ] 0.1 Collect the stop corpus from `autonomous-swarm` 0.2 (real transcripts, labelled).
      Include negatives: turns that end legitimately with a summary and no question.
- [ ] 0.2 Failing test: a turn ending "I'll wait for peer X to resolve Y" is today treated as
      neither stalled-for-a-reason nor continued (records current behaviour).

## Phase 1: Blocker schema and ladder state

- [ ] 1.1 Front-matter schema for `.skein/blocker.md` (`needs`, `waiting-on`, `asked-at`,
      `deadline`, `rung`), closed, parsed at load; legacy free-text blockers still read as
      `needs: team`.
- [ ] 1.2 Observed-red tests: unknown key, `needs` neither team nor human, rung out of order.
- [ ] 1.3 Rung enforcement: at most one send per `(item, rung)`, with a positive control that
      an identical second condition does not resend.

## Phase 2: Stop classifier

- [ ] 2.1 `loop/stop-reason.ts`: pure classifier (asking-user / waiting-on-peer / done /
      other), no imports from `loop.ts` (cycle rule in `similarity.ts`).
- [ ] 2.2 Wire to iteration handling: classified stop → ladder nudge, bounded (3 per item),
      then record a `needs: team` blocker and continue the queue.
- [ ] 2.3 Replay the corpus: report precision/recall and false nudges per hour. Ship only if
      false nudges are tolerable (decide threshold with the operator).

## Phase 3: Wake instead of poll

- [ ] 3.1 Register wake on peer reply/idle via `PeerInbox`; deadline timer persisted with the
      loop record so a restart keeps it.
- [ ] 3.2 On wake, re-check the blocker and resume the item; on deadline, perform rung L2
      (one request to the lead) exactly once.

## Phase 4: Text

- [ ] 4.1 Rewrite the relevant paragraph of `send-peer-message.txt`; keep the storm
      protections verbatim.
- [ ] 4.2 Add the ladder to the crew charter (`crew-loop` 3.2) and the Claude Code fragment.

## Phase 5: Live

- [ ] 5.1 Two members, deliberate cross-dependency: A blocked on B's change. Success: A moves
      to another item, B's reply wakes A, the human is not contacted.
- [ ] 5.2 Negative control: `needs: human` blocker (credentials) reaches the board and the
      lead brief and does not stop the member.
