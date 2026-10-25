# Tasks: adopt upstream ACP + service, retire fork residue

Ordering is enforced: verification before deletion; deletion before installer swap.

- [ ] 1.1 Drive the charter §7.6 ten lifecycle assertions against upstream `opencode
      service` (start-without-TUI, survive-TUI-close, second-client attach, dual
      observation, multi-worktree sessions in one project scope, durable state across
      kill, restart reconciles process+repo truth, no re-owned task, abandoned worktree
      preserved, long-run resource profile). Result: evidence doc, one row per
      assertion.
- [ ] 1.2 Confirm §6.4 coverage via `acp-external-verification` (Scenario A on
      upstream); if it is not yet run, this change's deletion steps wait for it.
- [ ] 1.3 Gap ledger: every failed assertion becomes (a) a reasoned upstream PR or
      (b) a documented gap with mitigation. Neither class may be skipped or merged.
- [ ] 1.4 Record `--agent` flag status: present in v2 run path or the preserved-delta
      list; if missing, open the PR attempt and keep the preserved-delta entry until
      resolved.
- [ ] 1.5 Migrate-or-fresh decision for fork-era state dirs (input from
      `v2-rebaseline`); migration test against a real snapshot (K13).
- [ ] 1.6 Delete `acp/`, `context/`, `fork/` and the ported areas per the recorded
      dispositions; the retained-delta list shrinks to the recorded minimum.
- [ ] 1.7 Archive `skein2/acp-sdk-1.8` (branch + change artifacts) and mark
      `01-acp-migration.md` as historical/sunk-cost.
- [ ] 1.8 Installer swap documented and gated on 1.1–1.6 green; the fork's
      `~/.local/bin/opencode` (1.18.18-dev) path recorded as retired.
- [ ] 1.9 Update AGENTS.md + `~/dev/skein/docs/ECOSYSTEM.md` sync policy: forward
      changes target the plugin repo; upstream sync policy per the new delta reality.
