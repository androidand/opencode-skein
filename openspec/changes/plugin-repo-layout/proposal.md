# Plugin repo layout: one repo, plugins as packages (ADR 13)

Parent: Phase 1a item P1.1. Decision gate for P1.3–P1.8; carries the evaluation's
remaining open decisions into ADR form so the ports do not re-litigate them.

## Why

The plugin route is settled (P1.2 verdict: "go plugins", toolchain proven on pinned
v2.1.3). What is not settled is where the plugins live and how their host coupling is
governed. Every trap in `skein2-p1.2-findings.md` that costs afternoons is a *repo-level*
property: the exact `effect` pin must match the opencode release (trap 1), path-plugin
entrypoints must sit at package root (trap 2), and a misshaped plugin loads silently
(trap 3). Crash isolation (`core/src/plugin/supervisor.ts`) is still unverified and must
be proven before porting TUI-heavy code (risk K3).

## Decision (ADR 13, recommendation — the maintainer lifts the publishing gate)

**One plugin repo, one plugin per package.** `androidand/skein-plugin` (name to be
confirmed with the operator) containing `skein-local`, `skein-peer`, `skein-loop-crew`,
`skein-beads`, and the `skein-cli` binary as workspace packages shipping from one CI.
Rationale:

- The plugins share claim/delegation state and the llama-skein provider plumbing;
  splitting repos multiplies the `effect`-pin and CI stories for zero isolation gain
  (opencode loads each package per location, in-process, so there is nothing to isolate
  at the repo boundary).
- One lockfile = one pin bump per upstream release (trap 1's cost is paid once).
- Repo-split also breaks the cross-package `worktree.transform` registration the loop
  port needs (P1.5).

Rejected: one repo per plugin (release coordination ×4 without an isolation
benefit — plugins are in-process either way), and keeping everything in
opencode-skein (drags the doomed fork layout along and forbids a clean v1 rename).

## What Changes

1. ADR 13 written in `02-architecture-decisions.md` with the alternatives above.
2. **Supervisor isolation proof:** a deliberate corrupt-plugin kill-test against pinned
   v2.1.3; result recorded before P1.3's TUI port starts. If isolation fails, the layout
   amends to one plugin per *failure-relevant* surface — a recorded amendment, never a
   silent assumption.
3. Plugin repo scaffold: workspace, the exact-pin `effect` + `overrides` template from
   the P1.2 skeleton, root entrypoints, the CI gates below.
4. CI gates: exactly one `effect` in the tree; every configured plugin resolves
   (`Host.resolve`) and appears in `plugin.list`; the negative control (P1.2 trap 3's
   deliberate unresolvable probe).

## Non-goals

- No Skein feature code moves in this change (P1.3–P1.6).
- Creating the remote repo is the operator's explicit publishing instruction;
  everything before it stays local.

## Risks

- If supervisor isolation proves absent, every TUI port inherits a host-crash blast
  radius — that is K3; the kill-test decides, no speculation.
- Repository name/shape vetoed by the operator after the fact — keep it local-only
  until confirmed to control publishing.

## Impact

One ADR, one verified downside (isolation), one scaffold repo replacing
`skein-plugin-skeleton` as the port's home. Unblocks P1.3.
