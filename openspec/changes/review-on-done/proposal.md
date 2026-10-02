# Review on done: an independent agent checks the exact commits

Parent: `autonomous-swarm` (F5). Inspired by Claude Code peer-programming plugins: when the
implementing agent says done, a hook calls another agent — preferably a different model —
to review exactly what changed.

## Why

The queue loop's verify gate already runs a reviewer subagent over `git status --porcelain`
and `git diff HEAD` with an `LGTM`/`NEEDS_WORK` token (`loop/loop.ts` ~L1005–1060). Its
limits for the operator's goal:

- the reviewer shares the author's model family unless a persona pins one — same blind spots;
- it reviews the working tree, not a named commit range, so it cannot attest to a head SHA;
- it exists only inside a queue loop — plain opencode and Claude Code sessions get nothing;
- the verdict is not recorded where a merge decision can require it.

## What Changes

1. **Review trigger on done** for any session: loop completion (via `loop-done-handoff`'s
   hook point) and, for Claude Code, a `Stop` hook running `skein review-on-done`.
   Triggers only when the session produced commits or a diff since its base and the change
   or branch is not already approved at that SHA.
2. **Reviewer selection that differs from the author**: prefer a different harness, else a
   different model family, else a different model; routed with the same warm-capacity logic
   as crew work (`peer-capacity-subagents`, `crew-loop` 2a). If no independent reviewer is
   available, the review is marked `same-model` and the policy decides whether that suffices.
3. **Exact range, pointers not paste**: the request carries `base..head` SHAs, the worktree
   path, the change slug and acceptance criteria locations. The reviewer reads the range
   itself in a detached worktree at head (no mutation of the author's tree).
4. **Verdict as evidence**: `LGTM`/`NEEDS_WORK` plus findings, written to
   `.skein/review.json` as `{headSHA, base, reviewer{harness,model}, verdict, findings,
   round}`. `standing-publish-authority`'s merge requires `LGTM` for the current head;
   skein's `ReviewVerdict` gate evidence reads the same file.
5. **Bounded rounds**: `NEEDS_WORK` reopens implement with the findings; at most 3 rounds,
   then the ladder (`escalate-before-idle`) sends it to the lead. A re-review happens only
   for a new head SHA.
6. **Findings rules**: the reviewer must cite file and line for each finding and separate
   blocking from advisory; a review with no verdict token is "no verdict", not a pass.

## Non-goals

- Not a replacement for CI or the verify gate's test run.
- No auto-fix by the reviewer; it reports.
- No review of a SHA already approved.

## Impact

`loop/loop.ts` (generalise the verify reviewer to the commit range, add selection),
new `review/on-done.ts`, `peer/delegate.ts` request type, `cli/cmd` (`review` subcommand),
Claude Code hook config fragment, `.skein/review.json` schema, tests.
