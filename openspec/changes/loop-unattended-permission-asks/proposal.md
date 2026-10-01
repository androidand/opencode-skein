# Loop sessions never hang on a permission ask

## Why

Several long-running instances were observed stuck while `/loop` was active; turning
the loop off let them continue working. Root cause, confirmed by reading the code
rather than guessing:

- `Permission.ask` blocks on a `Deferred` with no timeout (`permission/index.ts`) —
  a rule that resolves to `"ask"` waits for a human to call `reply()`, forever, if
  nobody does.
- `loop.ts` never calls `permission.reply` anywhere. A comment already at the
  `create()` call site claimed the queue-mode permission overlay "marks the run
  unattended so it never stops to ask" — it didn't; it only applied `QueueDenyRules`
  (deny-only, bash-only, queue-mode-only), and only in queue mode.

So any loop iteration — prompt mode included — that reaches a tool needing an `ask`
not already covered by an explicit `allow` (e.g. a role's own `websearch: "ask"`)
hangs forever with nobody watching to answer it. Turning the loop off cancels the
in-flight turn (`promptSvc.cancel`), which is why it looked like disabling the loop
"fixed" it — nothing was ever actually answered.

Decision (explicit, from the user): a loop should never stop to ask. Auto-allow,
always, no exceptions requested — this is a deliberate choice, not a default.

## What Changes

- New `session/unattended.ts`: a plain `Set<SessionID>` of sessions with nobody to
  answer a permission prompt. `mark`/`unmark`/`isUnattended`. Kept as its own leaf
  module (no imports of `loop` or `permission`) so both can depend on it without a
  cycle.
- `permission/index.ts`: `ask()` treats an `"ask"` rule as allow when
  `Unattended.isUnattended(sessionID)`. An explicit `"deny"` is untouched — it still
  fails the call immediately, exactly as before. Only the undecided default changes.
- `loop.ts`: marks the loop's session on `create()` (every mode, not just queue —
  a prompt-mode loop is just as unattended), unmarks it in `finalize()` and in
  `cancel()` (which bypasses `finalize`).
- `task.ts`: a subagent spawned under an unattended session is marked too, so
  nested delegation inherits the same guarantee. Unmarked when the subagent
  finishes (success, error, or interrupt), alongside the existing slot-release
  cleanup, so a long-running server's registry does not grow unbounded.

## Non-Goals

- Not touching `QueueDenyRules` or its scope (still bash-only, queue-mode-only,
  still hard `deny` for `git push`/`gh pr merge`/deploy/ssh/publish/credential
  access). This change only removes the *hang*; it does not relax or extend what
  is already an explicit deny anywhere.
- Not a general "background tasks never ask" change, though background subagent
  tasks have the identical nobody-to-answer problem — out of scope here since it
  wasn't what broke, and deserves its own look rather than folding in unreviewed.

## Impact

- `packages/opencode/src/session/unattended.ts` (new)
- `packages/opencode/src/permission/index.ts`
- `packages/opencode/src/loop/loop.ts`
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/test/permission/next.test.ts` (regression test: proven to hang
  on the old code, passes on the new)
