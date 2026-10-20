# ACP external-client verification

Parent: Phase 1 (ACP modernization). Completes the fluent-SDK migration landed on branch
`skein2/acp-sdk-1.8` (`docs/skein-2/01-acp-migration.md`). Proves charter Scenario A.

## Why

The ACP migration to the fluent SDK 1.8.0 is implemented and unit-tested, but the
compatibility tests mock the client side. The charter (§6.4) requires "compatibility with
at least one independent ACP client" and "validate against the actual external protocol,
not only unit tests that mock every method." Until a real external client drives a real
session over the wire, the migration is not proven, and the deprecated
`AgentSideConnection` compatibility switch cannot be removed with confidence.

Research (R1, answered): ACP's current stable protocol version is `1`. Official SDKs
exist in TypeScript, Python, Rust, Kotlin, and Java; Zed is the primary client. To avoid a
shared-SDK bug masking a wire mismatch, the verifying client is built on a **different**
official SDK than the agent's TypeScript SDK — Python or Rust.

## What Changes

1. Add an integration test that drives a real opencode-skein ACP agent with an
   **independent** ACP client (Python or Rust official SDK, protocol v1), over the real
   wire — no mocked client.
2. The test performs the full Scenario A sequence: initialize + capability negotiation,
   create session, submit a coding prompt, receive streamed updates, respond to a
   permission request (both accept and deny), and cancel an active turn.
3. Record the chosen client (SDK + version) and the negotiated `protocolVersion` as
   evidence, with the request/response transcript captured as an artifact.
4. Gate removal of the deprecated `AgentSideConnection` compatibility switch on this test
   passing.

## Non-goals

- No ACP v2 (charter §6.4: evaluate separately; not a prerequisite for Skein 2.0).
- No changes to the agent's business logic — this is a verification harness.
- No Zed GUI automation (heavy); the SDK client is the primary instrument. Zed remains an
  optional manual smoke check.

## Risks

1. **SDK skew.** The independent SDK may differ from the agent's SDK on a message.
   Mitigation: pin both to protocol v1 and record versions; a mismatch is a finding to
   report, not a test failure to hide.
2. **Permission/cancel timing is racy.** Mitigation: bounded waits with explicit timeouts
   and captured transcripts as evidence.

## Impact

New test harness (e.g. `packages/opencode/test/acp-external/` or a standalone script), a
CI job, and evidence artifacts. No production code changes expected; any fix discovered is
filed as a follow-up commit referencing this change.
