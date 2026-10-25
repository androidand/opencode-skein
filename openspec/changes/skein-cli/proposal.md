# `skein` CLI over the plugin RPC + server API (P1.8)

Parent: Phase 1a item P1.8. Slots after `adopt-upstream-acp-and-service`'s verification
chain (it documents the same surfaces), but scaffoldable in parallel.

## Why

The `opencode loop|agents|beads` subcommands die with the fork. Charter §17 requires the
platform to be diagnosable without the dashboard: `skein status`, `skein projects`,
`skein agents`, `skein work ready|running|blocked`, `skein fleet`, `skein trace
<execution-id>`, `skein doctor`. A standalone binary over the plugins' RPC and the
opencode server API replaces the subcommands and becomes the control plane's
user-facing surface later.

## What Changes

1. `skein-cli` package (language decision in design.md — recommendation: Go, per
   charter §9.3's preference and the control plane's language; the RPC/server client is
   thin) driving the plugin RPC surfaces (locations per P1.2 trap 5/7 discipline) and
   the opencode server API.
2. Implement the §17 command set with the correlation-ID plumbing available to
   `skein trace` once `skein-observability` lands; until then `trace` renders what IDs
   exist (session/execution) and says explicitly what is missing — never fabricates.
3. `skein doctor` includes the planning-freshness check (docs/skein-2 copy vs loose
   companions, K15) and the plugin health probes (one `effect` in tree, resolution
   probe) to make CI's gates visible locally.
4. Replaces the `opencode loop|agents|beads` subcommands referenced in
   `port-beads-plugin`'s interim parity; that interim path is retired with evidence
   that the CLI reads/writes the same records.

## Non-goals

No dashboard UI (mission-control). No new authority — the CLI acts with the invoking
user's grants, never as the lead (charter §14.1).

## Risks

- Verb drift from specsync/openspec CLI conventions — pin command shapes to the §17
  list and keep verbs stable.

## Impact

New binary replacing the inherited subcommands; diagnostic surface for every later
phase; sentinel for observability IDs.
