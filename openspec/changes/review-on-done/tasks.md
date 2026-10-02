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
