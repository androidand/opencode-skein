# Tasks: ACP external-client verification

## Phase 0: Choose and pin the independent client

- [ ] 0.1 Pick the independent client SDK (Python or Rust official ACP SDK, protocol v1)
      and record its version. It MUST be a different official SDK than the agent's
      TypeScript SDK.
- [ ] 0.2 Confirm the agent negotiates `protocolVersion` 1 and record the value.
- [ ] 0.3 Stand up a minimal real opencode-skein ACP agent under test (reuse the
      `skein2/acp-sdk-1.8` agent; no business-logic changes).

## Phase 1: Scenario A sequence

- [ ] 1.1 initialize + capability negotiation succeeds.
- [ ] 1.2 newSession creates a session; a session id is returned.
- [ ] 1.3 prompt streams at least one assistant update to the client.
- [ ] 1.4 permission request: client accepts; the tool proceeds.
- [ ] 1.5 permission request: client denies; the tool is blocked and the denial is
      reported.
- [ ] 1.6 cancel an active turn; the agent stops and reports cancellation.
- [ ] 1.7 client disconnects mid-session; the agent session is handled per policy
      (preserved or cleaned) without crashing.

## Phase 2: Evidence and gate

- [ ] 2.1 Capture the full request/response transcript as a test artifact.
- [ ] 2.2 Wire the test into CI against the agent on `skein2/acp-sdk-1.8`.
- [ ] 2.3 On green: remove the deprecated `AgentSideConnection` compatibility switch in a
      separate commit that references this change.
- [ ] 2.4 Record evidence in `findings.md`: client SDK + version, negotiated
      `protocolVersion`, transcript path, CI run id.
