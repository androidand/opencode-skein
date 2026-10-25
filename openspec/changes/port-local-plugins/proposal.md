# Port `local/` to plugins (P1.3): llama-skein provider, gallery, placement, ctx-fit

Parent: Phase 1a item P1.3 — the biggest port (10.2k LOC, the biggest fork-only tree).
Depends on `plugin-repo-layout` (ADR 13 + isolation proof).

## Why

`src/local/` is the largest casualty of carrying a fork: mDNS/LAN discovery, the
llama-skein client (`gen/` is contract-generated from
`llama-skein/contracts/llama-skein.openapi.json`), provider/model domains, the gallery,
mode placement and context-fit — all patching upstream internals. Under opencode 2 the
extension point is the plugin system proven in P1.2; the fork port cost returns at every
upstream release otherwise (risk K1). The AGENTS.md rules (never hand-edit `gen/`,
contract-first, `--agent` flag) move from "fork rules" to "plugin rules".

## What Changes

1. Port the provider/model domain code into the `skein-local` plugin package,
   registering via `rpc.register`; expose the server and TUI entrypoints as plugin
   locations; the 6 TUI dialogs become TUI-plugin routes (debug-wrapped per trap 8
   until the isolation proof (P1.1) is green).
2. Regression gate: the existing `test/local/` + `test/server/` suites, re-pointed at
   the plugin packages; tests that can only pass through fork internals are rewritten
   at the plugin boundary, not deleted silently.
3. Placement corrections per charter §11.4 ("warm-peer routing verifies the model ID;
   idle-sorting matches policy; session reuse keeps task context; capacity is not
   double-counted; per-location plugin location semantics carried per trap 5/7"), with
   regression tests added in scope.
4. Live smoke: one model-invoked tool run under real credentials (`ek`) closes the P1.2
   gap (K11 — tool never fired by a model).
5. Pick and stick to one RPC-schema flavour per package (R-P5), recorded in design.md.

## Non-goals

- No llama-skein API changes (its OpenAPI contract is the other side's source of truth;
  anything needed is a contract PR there, coordinated with its owner).
- No loop/crew state model changes (P1.5's scope). No ACP work.

## Risks

- The mDNS discovery path touches process/OS behavior — its tests run in real-network
  mode only; the plugin boundary must not silently drop the scan loop (K5 detection).
- Largest LOC surface; estimate is a dedicated decision not this proposal's job — the
  P1.5 estimate-review practice applies.

## Impact

`skein-local` plugin package + re-pointed tests + placement regressions + live smoke.
The fork's `src/local/` title as biggest fork-only tree is retired; what remains in the
fork from this area is the delta map `v2-rebaseline` records, dispositioned in P1.7.
