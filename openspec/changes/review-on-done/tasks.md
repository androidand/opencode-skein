# Tasks: review on done

## Phase 0: Baseline

- [ ] 0.1 Record on a real run: which model the verify reviewer used vs. the author, its
      input, whether anything persisted (`autonomous-swarm` 0.5).
- [ ] 0.2 Failing test: reviewer input for a committed change (clean tree) is empty today,
      so a committed-but-unreviewed change reviews as "(empty)".

## Phase 1: Range-based review

- [ ] 1.1 `review/range.ts`: resolve `base..head` for a change/branch/worktree; detached
      worktree at head for the reviewer; cleanup.
- [ ] 1.2 Generalise the verify gate to the range; keep the token verdict and the
      "no token = no verdict" rule.
- [ ] 1.3 `.skein/review.json` schema (closed, validated at read) and writer.

## Phase 1b: Record authenticity (found in review of the record reader, 2026-10-02)

The record lives in the AUTHOR's working tree, so as a bare file it proves nothing: the author's model
can write its own LGTM. The reader (src/policy/review-record.ts) therefore carries the reviewer's
identity as a claim (`reviewer.sessionID`) and the verdict's `independence`; these tasks make the claim
true.

- [x] 1b.1 `src/policy/review-gate.ts` writes the record from the caller's own session identity
      (`ctx.sessionID`, in-process — not parsed from a message, so it does not wait on callback
      confirmation), validates against the reader's own closed schema before writing, and writes
      atomically. The tool registration itself is the remaining wiring.
- [ ] 1b.2 Deny `edit` and `write` of `.skein/review.json` for ordinary sessions (the fenced-path rules,
      same mechanism as the other protected paths), with a bypass-shape test.
- [x] 1b.3 (driver side: `mayMerge` takes `authorSessionID`/`requireIndependent`; no caller passes the author yet, the merge CLI that will is not written) The merge driver refuses a verdict whose `reviewer.sessionID` is the author's session, and
      surfaces `independence` so a policy can require `independent`.
- [x] 1b.4 `gate()` supplies `authorSessionID` to `mayMerge`, which refuses a verdict the author's own
      session wrote. Mutation-checked: removing the author comparison fails that test and only it.
- [ ] 1b.5 NOT DONE, and it is the one that matters: a record forged by shell, naming a real reviewer,
      is still accepted. `.skein/review.json` is writable by any process with filesystem access and the
      gate only checks that the reviewer differs from the author. Pinned as a test so it cannot be
      forgotten. Only OS separation closes this, and nothing here claims it.

## Phase 2: Independent reviewer

- [ ] 2.1 Selection function over roster + models (different harness > different family >
      different model > same-model flagged); unit tests per branch including "none available".
- [ ] 2.2 Request/reply over the peer envelope with deadline; reviewer answers once.
- [ ] 2.3 Round counter, max 3, then hand to the ladder.

## Phase 3: Triggers

- [ ] 3.1 Loop completion hook (after `loop-done-handoff` 1.2).
- [ ] 3.2 `skein review-on-done` CLI + Claude Code `Stop` hook fragment; no-op when no new
      commits or head already approved; guard against hook re-entrancy (the reviewer's own
      Stop must not trigger a review).

## Phase 4: Consumers

- [ ] 4.1 Merge driver (`standing-publish-authority` 3.3) requires `LGTM` for current head.
- [ ] 4.2 Skein `ReviewVerdict` evidence mapping (cross-repo, Phase 6.3 of the epic).

## Phase 5: Live and controls

- [ ] 5.1 Real change reviewed by a different-family model; findings fed back; second round passes.
- [ ] 5.2 Negative controls: a seeded defect is caught; a stale review (new commit) is not
      accepted by merge; a reviewer reply with no token fails the gate; the review hook does
      not recurse.
