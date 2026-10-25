# v2 re-baseline: unshallow, pin upstream v2.1.3, record the delta

Parent: Phase 1a item P1.0 (plugin port). Must precede every port change.

## Why

The shallow clone already caused one false ancestry conclusion, and every planning
claim downstream (P1.3–P1.9) needs the pinned target and the exact fork/upstream
delta as ground truth. The evaluation verified the numbers only against
`opencode-skein@dev` (5fea944430) and `upstream/dev` (09a1db3b08, opencode v2.1.3);
a tagged release is the deliverable, not branch drift. This is mechanical, but it is
the lock everything else clips into.

## What Changes

1. `git fetch --unshallow upstream` on `~/dev/opencode-skein` and assert bounded
   ancestry (`rev-list --count`) before any claim that cites it.
2. Pin the target release: v2.1.3 (tag, not `dev`), recorded in
   `docs/skein-2/00-current-state.md` and every port change's tasks.
3. Generate the fork/upstream delta map: every fork-only source tree and every
   upstream file the fork cuts into (the evaluation's two lists, regenerated fresh
   against the pinned tag) — written into `docs/skein-2/00-current-state.md`.
4. Record the fork-specific mutable state (config/state dirs, data formats) for the
   migration decision in `adopt-upstream-acp-and-service`.

## Non-goals

- No code changes. No behavior change. No architecture decision here (that is
  P1.1's ADR 13).
- No attempt to rebase the fork (the 500–700 commit gap stays; retirement, not
  rebasing, is the plan).

## Risks

- Ancestry assertions made against a still-shallow repo silently pass wrong —
  hence the unshallow step is part of validation, not a prerequisite to it.
- The delta map regenerates differently across agents; make it a script output
  (`git diff --stat`, name-only), committed as data, never hand-copied.

## Impact

Planning docs update; no runtime impact. Gates K8 (shallow clone) closed.
