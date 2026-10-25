# Tasks: plugin repo layout (ADR 13)

## Phase 0: Isolation proof (blocks P1.3)

- [ ] 0.1 Corrupt-plugin kill-test against pinned v2.1.3: a plugin whose server
      entrypoint throws at load, one that throws during a tool call, and one that
      throws inside a TUI route render; record in each case whether the host stands.
- [ ] 0.2 Write the result (expected: isolate / fails-open) into `design.md` as the
      ADR 13 annex. If fails-open, amend the layout per the proposal and re-check.

## Phase 1: Repo scaffold (local only until the operator authorizes publishing)

- [ ] 1.1 Scaffold `androidand/skein-plugin` workspace from `skein-plugin-skeleton`:
      one package per plugin (`skein-local`, `skein-peer`, `skein-loop-crew`,
      `skein-beads`) + `skein-cli`; root entrypoints per trap 2; exact-pin `effect`
      + `overrides` per trap 1; JSON-Schema-vs-Effect RPC flavour recorded per package
      (R-P5).
- [ ] 1.2 CI gates: exactly-one-`effect` assertion; `Host.resolve` probe per package,
      failing loudly; duplicate-ID detection (re-use the observed `plugin.list`
      behavior); the P1.2 acceptance probe re-run per release pin bump.

## Phase 2: Handover notes

- [ ] 2.1 Record the promoted skeleton location and any local paths the P1.3–P1.6
      worktrees must invent/move (including `skein-plugin-skeleton/script/tui-drive.py`,
      K12).
- [ ] 2.2 The operator's explicit go-ahead to create and publish the remote repo is
      recorded here as the gate it is; no remote activity before that.
