# Tasks: Fix spec-queue loop reading tasks.md from the wrong branch

## Phase 1: Reproduce and confirm

- [x] 1.1 Write a failing test: two changes on different branches, loop switches between them, queue reports wrong next task
  - Validation: `bun test packages/opencode/test/loop/spec-queue.test.ts`
  - Note: Test should create a temp repo with two changes on two branches, check out branch A, resolve queue (expect change A's tasks), check out branch B, resolve queue (expect change B's tasks, not A's stale state)
  - Done: "resolveQueue is branch-aware" describe block builds a temp git repo, loop/change-a carries change-b="1.2 beta" (its own branch) while the working tree carries change-b="1.2 alpha"; asserts resolveQueue + cursor read beta regardless of checkout. Verified regression: fails 36/2 against working-tree-only read, passes 38/0 with branch-read.ts.

## Phase 2: Fix

- [x] 2.1 Make `readTasks` branch-aware: read tasks.md from the change's branch via `git show` when the working tree is on a different branch
  - Validation: `bun typecheck` in packages/opencode
  - Note: `git show loop/<slug>:openspec/changes/<slug>/tasks.md` with fallback to direct file read when branch doesn't exist or git fails
  - Done: added `src/loop/spec-queue/branch-read.ts` (`readChangeFile`/`showRef`) used by `readTasks` in `queue.ts`
- [x] 2.2 Update `buildBrief` to use the same branch-aware read for the tasks.md content it embeds in the prompt
  - Validation: `bun test packages/opencode/test/loop/spec-queue/`
  - Done: `buildBrief` derives `root` from `change.directory` and reads tasks.md via `readChangeFile`
- [x] 2.3 Add integration test: full loop iteration across two changes on different branches produces correct briefs
  - Validation: `bun test packages/opencode/test/loop/spec-queue.test.ts`
  - Done: "resolveQueue is branch-aware" describe block covers resolveQueue + buildBrief together across branch checkouts

## Phase 3: Verify

- [x] 3.1 Run full loop test suite
  - Validation: `bun test packages/opencode/test/loop/`
- [x] 3.2 Typecheck
  - Validation: `bun typecheck` in packages/opencode
