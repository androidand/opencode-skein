# Tasks: loop-unattended-permission-asks

- [x] 1.1 `session/unattended.ts`: `mark`/`unmark`/`isUnattended` over a plain
      `Set<SessionID>`, no dependency on `loop` or `permission`.
- [x] 1.2 `permission/index.ts` `ask()`: an `"ask"` rule auto-allows when the
      session is unattended; `"deny"` unaffected. Unit tests in
      `test/permission/next.test.ts`, including one proving deny still applies.
- [x] 1.3 `loop.ts`: mark on `create()` for every mode; unmark in `finalize()` and
      in `cancel()` (which bypasses `finalize`).
- [x] 1.4 `task.ts`: propagate the mark to a spawned subagent when its parent is
      unattended; unmark on subagent completion alongside the existing slot
      release.
- [x] 1.5 Regression test proven to hang on the pre-fix code (5s timeout) and pass
      on the fix, without an explicit `Effect.forkScoped` race — a real hang, not
      a timing-sensitive assertion.
