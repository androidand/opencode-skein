# Adopt upstream ACP + `opencode service`, retire the fork (P1.7)

Parent: Phase 1a item P1.7. Slots after the ports (P1.3–P1.6). This change is where
the fork boundary is crossed; the verification contract (charter §6.4, §7.6) governs
it.

## Why

The v2 pivot exists because carrying a 241-file fork costs a restructure-port per
upstream release. After P1.3–P1.6 the remaining fork code is `acp/` (superseded — we
adopt upstream's), `context/` and `fork/` residue. Cutting over is justified only if
upstream demonstrably covers the two verification contracts:

- **§6.4 (ACP)**: the external-client test list. The unit-level migration on
  `skein2/acp-sdk-1.8` proved the *API shape*; upstream adoption must prove the
  *behavior* via `acp-external-verification` (Scenario A).
- **§7.6 (lifecycle)**: the ten assertions (start without TUI, survive TUI close,
  attach second client, dual observation, multi-worktree sessions in one project scope,
  durable state across kill, restart reconciles process+repo truth, no re-owned task,
  abandoned worktree preserved, acceptable long-run resource profile). The evaluation
  said explicitly this was **not check**'d; it must be driven live before residues are
  deleted.

## What Changes

1. Drive the §7.6 ten assertion against upstream `opencode service` live, and the §6.4
   list against upstream's ACP via `acp-external-verification`. Failures become either
   reasoned upstream PRs or documented gaps with mitigations — never a new fork.
2. Retire in-fork remnants per the decision (charter §19-revised): delete `acp/`,
   `context/`, `fork/` and the ported areas (`local/`, `peer/`, `loop/`-.Tree,
   `beads/`) as recorded by the port changes' dispositions; the retained-delta list
   (deliberate deviations, if any) shrinks to the recorded minimum, each with a
   documented upstream route or justification.
3. Archive the `skein2/acp-sdk-1.8` branch and its change artifacts; the often-cited
   docs (`01-acp-migration.md`) remain as historical record, marked as sunk cost.
   (Evaluation decision 3.)
4. Swap the operator's running opencode over: the fork binary installs
   (1.18.18-dev in `~/.local/bin/opencode`) are replaced after the new-plugin stack is
   proven; the migration-or-fresh decision for fork-era state dirs (from
   `v2-rebaseline`'s R-P1 inventory) is recorded before the swap.
5. Update ecosystem docs (AGENTS.md, `~/dev/skein/docs/ECOSYSTEM.md` sync-policy
   section) to the new reality: plugin repo + retained delta, no `--agent` flag unless
   it survives P1.7 review as an upstream-able patch.

## Non-goals

- No reimplementation of anything §7.6/§6.4 confirms upstream covers.
- No upstream contribution obligations invented here beyond reasoned PRs for
  demonstrable gaps.

## Risks

- Deleting fork code before verification would strand autonomy behaviors; the order
  above is enforce-only-after-evidence.
- `--agent` flag (`src/cli/cmd/run.ts`) is skein-ecosystem-critical (skein's supervisor
  calls it); if upstream lacks it, it becomes a preserved-delta item with a PR attempt.
  Removing it is unacceptable per AGENTS.md.

## Impact

Fork retirement, a documented gap list, installer swap, dated residue inventory. The
platform's execution plane is upstream opencode + `skein-plugin` from here on.
