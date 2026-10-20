# Change: mission-control

## Why

Charter §13 requires a unified Mission Control dashboard: global overview, agent detail,
work graph, agent-communication view, lead chat, resource dashboard, and approvals.

Research (R9) found opencode-skein's `packages/web` is `@opencode-ai/web`, an **Astro
docs site** (`content/`, `pages/`, `i18n/`) — not a control dashboard. `session-ui` is a
component library; `desktop`/`tui` are the existing session surfaces. There is **no
existing control-plane dashboard**. Per ADR 10, this change builds a **small independent
dashboard** that reads from the control-plane API and AHP projections rather than
extending the OpenCode web UI (which would couple the dashboard to OpenCode internals and
not expose cross-repo control-plane state).

## What Changes

- A small independent web dashboard (new package) that reads **only** from the
  control-plane API and AHP session projections — never the workflow database directly.
- Views: global overview (objectives, active agents, blocked work), agent detail (session,
  turns, resource leases), work graph (dependencies + claims), agent-communication view
  (peer/A2A messages), lead chat (drives the lead session), resource dashboard (GPU/inference
  leases via llama-skein), and approvals (pending grants with scope/target/risk/evidence).
- Reuses shared UI components/SDKs; the lead-chat tools (`swarm_*`) are stable contracts,
  optionally exposed via MCP.
- Reads from actual platform state; a stale or unreachable control plane is shown as
  degraded, not fabricated.

## Impact

- Affected specs: `mission-control` (new), `ahp-host` (session projections),
  `skein-control-plane` (API surface), `skein-observability` (metrics views).
- New web package; no changes to the execution plane or ACP runtime.
