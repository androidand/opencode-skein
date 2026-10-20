# AHP host: synchronized multi-client view of managed sessions

Parent: Phase 7 (AHP and Mission Control). Proves charter Scenario G.

## Why

The charter (§12) requires a standardized, synchronized, multi-client interface to managed
agent sessions. Today a session is only visible from the client that created it (a TUI or
CLI). AHP (microsoft/agent-host-protocol) is the standard for exactly this: "one host sits
between many clients and many agents," with immutable state, pure reducers, and
write-ahead reconciliation. This is a P2 capability — it adds a presentation and
synchronization layer on top of the execution plane; it is **not** the workflow database
(charter §4.4).

Research (R2, answered): AHP is JSON-RPC 2.0 over any reliable ordered transport. Channels
are URI routing keys (`ahp-root://`, `ahp-session:/<uuid>`, `ahp-chat:/<cid>`,
`ahp-automations://`, `ahp-automation-run:/<id>`, `ahp-terminal`, `ahp-otlp:`,
`ahp-mcp`). Every action is stamped with a monotonic `serverSeq` and broadcast to all
subscribers; clients apply optimistically and reconcile against the server echo. Official
client libraries exist in TypeScript (`@microsoft/agent-host-protocol`), Rust, Go, Kotlin,
Swift, and .NET. Conforming hosts already exist: the VS Code agent host (reference),
`pi-ahp`, `ahpd` (`@ahpd/sdk`), `hydra-ahp`, and `ahp-acp-gateway` (a universal AHP
WebSocket host that runs ACP agents with persistent sessions, replay + reconnect,
permissions, and cancellation).

## What Changes

1. Add an **independent AHP host** (a small service) that projects one or more managed
   opencode-skein sessions onto AHP channels. It reuses ACP as the runtime interface where
   practical (charter §12.2) and does not modify OpenCode's internal chat implementation.
2. **Read-only first** (charter §12.5): expose one managed session and connect two
   independent AHP clients. Both see the same conversation and tool activity.
3. Implement AHP reconciliation: ordered `serverSeq` actions, a snapshot on subscribe, and
   reconnect without duplicated or missing visible actions (charter §12.4, §12.6).
4. Then add interactive commands (prompt, cancel) and permission state, and finally
   multi-session discovery to feed the dashboard.

## Build approach (needs-research R8)

Three candidate approaches, decided in `design.md` before implementation:
- **A. Reuse `ahp-acp-gateway`** — a universal AHP WebSocket host that runs ACP agents
  with persistent sessions, replay + reconnect, permissions, and cancellation. Fastest
  path; least control over Skein-specific projections.
- **B. Build on `@ahpd/sdk`** — a plugin host where the agent, ports, and server tools are
  installed. More control; more work.
- **C. Build a thin host on the `@microsoft/agent-host-protocol` TS client lib** directly,
  projecting from the opencode-skein ACP agent. Most control; most work.

The decision depends on how much opencode-skein-specific state (work items, claims, gates)
must be projected — which AHP's standard channels may not express (charter §4.4 keeps
those in the control plane, exposed through AHP extensions "where suitable").

## Non-goals

- AHP is not the global workflow database (charter §4.4). Skein work graphs, approvals,
  fleet scheduling, dependencies, and policies stay in the control plane.
- No experimental AHP channels beyond what the current specification defines.
- No changes to the ACP agent or the execution plane for AHP's sake.

## Risks

1. **Labeling a custom WebSocket as AHP.** The charter (§12.3) forbids calling a custom
   event WebSocket "AHP-compatible" unless it conforms. Mitigation: use the official
   client lib or a conforming host; validate against the AHP JSON Schema.
2. **Competing mutable state.** Mitigation: keep internal event sourcing separate from AHP
   projection state (charter §12.4); the AHP host is a read projection, not an authority.
3. **Scope creep into the control plane.** Mitigation: read-only first; Skein-specific
   state via clearly defined extensions only.

## Impact

A new small service (the AHP host), an ACP→AHP projection adapter, two test clients, and
evidence. No changes to the execution plane.
