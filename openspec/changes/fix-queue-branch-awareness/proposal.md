# Fix: spec-queue loop reads tasks.md from the wrong branch

## Why

The spec-queue loop (`loop-spec-queue`) resolves its cursor by reading `tasks.md`
from the working tree (`resolveQueue` → `readTasks` → `fs.readFileSync`). When a
loop iteration checks out a different branch (e.g. `loop/change-a`) and the next
iteration targets a different change (e.g. `loop/change-b`), the queue resolution
reads `tasks.md` from whichever branch is currently checked out — not the branch
that belongs to the change being worked.

**Observed failure:**
The loop was working change A (all tasks checked, working tree on `loop/a`). It
then switched to `loop/b` for change B. When it returned to change A, the working
tree was still on `loop/b`, so `resolveQueue` read branch B's tasks.md and reported
a stale "next unchecked task" for change A. The loop burned 6+ iterations
re-reporting the same task, and the VERIFY gate reviewer hit its step limit
trying to verify a change that was already done.

## What

The queue loop SHALL ensure the working tree is on the correct branch
(`loop/<change-slug>`) before reading `tasks.md` to derive the cursor and next
unchecked task. Alternatively, the queue resolution SHALL read `tasks.md` from
the change's branch directly (e.g. `git show loop/<slug>:openspec/changes/<slug>/tasks.md`)
without requiring a checkout.

## Scope

- `packages/opencode/src/loop/spec-queue/queue.ts` — `resolveQueue` / `readTasks`
- `packages/opencode/src/loop/spec-queue/brief.ts` — `buildBrief` (reads tasks.md again)
- Possibly `packages/opencode/src/loop/loop.ts` — branch checkout before iteration

## Risks

- `git show` reads are slower than direct file reads, but tasks.md is small
- If the branch doesn't exist yet (first iteration of a new change), fall back to
  the working tree read
- Concurrent loops on different branches in the same repo could race on checkout;
  `git show` avoids this entirely
