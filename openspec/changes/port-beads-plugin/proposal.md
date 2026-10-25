# Port `beads/` to a plugin (P1.6)

Parent: Phase 1a item P1.6 (0.5k LOC — the smallest port, deliberately last).

## Why

`beads/` is the intake/task-bead surface (`opencode loop|agents|beads` subcommands sit
on it). It is small enough to move without design churn and is the last piece before
the fork residue can be dropped (P1.7). Porting a small surface late also validates
that the plugin wiring established by P1.3–P1.5 generalizes — a canary done cheaply.

## What Changes

1. Port the beads domain into the `skein-beads` package (tool/command registrations;
   RPC flavour per R-P5, recorded in design.md).
2. The `opencode loop|agents|beads` subcommands that sat on this area are planned to be
   replaced by the `skein` CLI (P1.8); until P1.8 lands, preserve equivalent access via
   the plugin's command/RPC surface.
3. Re-point the existing beads tests; same no-silent-deletion rule as the other ports.

## Non-goals

No new bead semantics. No CLI work (P1.8). No storage changes beyond what
`plugin-repo-layout` already chose.

## Risks

Low. Main risk is discovering the two earlier port packages carved out assumptions
beads relied on — if so, the regression finds it here, in the cheapest place.

## Impact

`skein-beads` package + re-pointed tests + the fork residue record for P1.7.
