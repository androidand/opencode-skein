# One live fleet session to verify what already shipped

## Why

Six placement/loop changes are fully implemented and unit-tested but each carries one
unchecked "verify against the real fleet" task. Keeping six changes open for six manual
checks hides what is actually left. This change is that list; the parents are archived.

## What Changes

Nothing in code. One session on the real hosts (rocky, m5, z4, …) with the checks below,
each recorded with the command run and what was observed. A failure reopens a focused
change with a reproduction; it does not reopen the parent.

## Impact

- Archived with a pointer here: `subagent-background-default`, `loop-eternal-by-default`,
  `persona-gate-fanout`, `role-placement-policy`, `provider-capacity-truth`,
  `ctx-aware-subagent-placement`.
- `skein-pool` 2.5 (delegation live check) is listed here too so it is one session.
