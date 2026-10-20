# Tasks: AHP host

## Phase 0: Decide the build approach (R8)

- [ ] 0.1 Evaluate `ahp-acp-gateway` vs `@ahpd/sdk` vs a thin host on the TS client lib.
      Criteria: how much Skein-specific state must be projected, maintenance burden, and
      conformance to the AHP spec.
- [ ] 0.2 Write the decision into `design.md` as ADR #4 (charter §22).
- [ ] 0.3 Pin the AHP protocol version and the client/host library versions.

## Phase 1: Read-only single session (charter §12.5)

- [ ] 1.1 Stand up the AHP host exposing one managed opencode-skein session.
- [ ] 1.2 Project session state, chat turns, and tool events onto AHP channels
      (`ahp-session:/`, `ahp-chat:/`).
- [ ] 1.3 Connect two independent AHP clients; both observe the same conversation and tool
      activity.
- [ ] 1.4 A subscribe returns a snapshot; subsequent actions arrive ordered by
      `serverSeq`.

## Phase 2: Reconciliation (charter §12.4, §12.6)

- [ ] 2.1 Disconnect one client; execution continues; on reconnect the client receives a
      correct state with no duplicated or missing visible actions.
- [ ] 2.2 Handle missed notifications, duplicate observations, and out-of-order arrivals at
      the adapter boundary.
- [ ] 2.3 Handle session termination and protocol version mismatch.

## Phase 3: Interactive (after read-only is proven)

- [ ] 3.1 Add interactive commands (prompt, cancel) through AHP.
- [ ] 3.2 Add permission state where supported.
- [ ] 3.3 Add multi-session discovery for the dashboard (feeds `mission-control`).

## Phase 4: Evidence

- [ ] 4.1 Record the AHP protocol version, the chosen host approach, and the client/host
      library versions.
- [ ] 4.2 Capture the two-client synchronized transcript and the reconnect reconciliation
      as evidence (Scenario G).
