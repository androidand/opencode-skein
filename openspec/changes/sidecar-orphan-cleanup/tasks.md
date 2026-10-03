# Tasks

## Phase 0: confirm the mechanism before fixing it

- [ ] 0.1 Reproduce the startup race. Spawn a sidecar from a process that exits immediately, so
      the child is already reparented when it reads `process.ppid`. Confirm it survives past the
      2s interval. The existing test at `test/peer/claude/sidecar-e2e.test.ts:222` deliberately
      waits for registration before killing the parent, so it cannot catch this.
- [ ] 0.2 Determine how a running sidecar ends up with no registration: parent exit inside the
      `Process.spawn` → `writeSidecarRegistration` window (`sidecar-manager.ts:121`), a failed
      write, or both. Instrument rather than assume.
- [ ] 0.3 Census the machine for other shapes of leak beyond the 44 observed on 2026-10-03, so the
      fix covers the real population rather than the one case that was noticed.
- [ ] 0.4 Decide whether the fix must also reclaim sidecars already leaked elsewhere. A fix that
      only prevents future leaks leaves existing ones running until someone sweeps by hand.

## Phase 1: make orphaning detectable from the sidecar

- [ ] 1.1 Choose the liveness signal: pass the owning session's pid explicitly and treat
      "absent or not alive at startup" as orphanhood, or have the parent hold the socket so the
      sidecar observes EOF. Record the choice and its trade-offs in the change.
- [ ] 1.2 Remove the reliance on a single startup reading of `process.ppid`
      (`sidecar-entry.ts:93`), which cannot detect a sidecar that was already orphaned.
- [ ] 1.3 Observed-red test for each scenario in the spec, mutation-checked: revert the fix and
      confirm the test fails, so a green result is evidence rather than decoration.

## Phase 2: make leaked sidecars reclaimable

- [ ] 2.1 Add an explicit operator command that identifies candidate sidecars: running, no live
      owning session, and either a stale registration or none at all. It SHALL report before it
      acts, and SHALL require confirmation.
- [ ] 2.2 It SHALL refuse any candidate whose owning session is live, even if that session is
      idle — the mistake that matters is killing a real session's sidecar.
- [ ] 2.3 Keep the boot sweep unchanged in behaviour: files for dead processes only, never a
      signal to a running one.

## Phase 3: close the registration window

- [ ] 3.1 Record ownership so a running sidecar is never both unregistered and unreclaimable,
      whether the session exits between spawn and registration or the write fails.
- [ ] 3.2 Test the failure path, not just the happy path.

## Notes

- Observed on 2026-10-03: 44 `bun.exe run <deleted-worktree>/…/src/index.ts debug
  claude-sidecar-entry` processes, `ppid 1`, ~16h old, sleeping, none holding a session database,
  none present in `~/.claude/sessions/` with `managedBy: "opencode-skein"`. All 44 were
  unroutable — `resolveOpencodeSender` resolves only through the registry — so they could not
  receive or be addressed, and were pure load. They were reclaimed by explicit PID after
  per-process verification.
- The 15 registered sidecars on the same machine were unaffected and spanned five repositories,
  so this is a specific hole in the guard rather than a general failure of it.
- Not in scope: sender identity, lead grants, review gating.