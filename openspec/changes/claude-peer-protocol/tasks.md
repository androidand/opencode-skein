# Tasks: claude-peer-protocol

Every field/path/permission cited below is confirmed in
`openspec/changes/claude-peer-protocol-spike/findings.md`, not assumed — read it first.

## Slice 1: Codec and registry (pure, no process/socket yet)

- [ ] 1.1 `packages/opencode/src/peer/claude/codec.ts`: encode/decode the two confirmed NDJSON
      frame shapes (`{"type":"auth","token":...}` and the message frame with `msgV`, `msg_id`,
      `type`, `message.content`, `priority`, `from`). Reject malformed/oversized frames cleanly.
  - Validation: unit tests — round-trip both frame shapes; malformed JSON rejected; oversized
    frame rejected
- [ ] 1.2 `codec.ts`: attribution envelope construct (`<cross-session-message from="..."
      from-name="..." from-mode="...">...</cross-session-message>`) and parse. Construction
      SHALL sanitize message text so it cannot forge a closing tag or a `from="..."`-shaped
      attribute; parsing SHALL treat envelope attributes as display context only, never as
      authoritative sender identity.
  - Validation: unit test — a message containing a literal `</cross-session-message>` or
    `from="forged"` is rendered inert in the constructed envelope
- [ ] 1.3 `packages/opencode/src/peer/claude/registry.ts`: read a registry entry
      (`<dir>/sessions/<pid>.json`) and its key file (`<dir>/sessions/<pid>.<sha256(
      messagingSocketPath)>.key`), matching the exact schema in `findings.md`. Read-only for now.
  - Validation: unit tests against fixture files matching the confirmed schema
- [ ] 1.4 `registry.ts`: write a registry entry + key file for a given PID/socket path, with the
      confirmed permissions (dir `0700`, registry/key files `0600`) and `procStart` computed as
      `TZ=UTC LC_ALL=C ps -o lstart= -p <pid>` (confirmed format). Refuse to write if the target
      runtime directory has insecure ownership/mode — fail closed with a specific diagnostic.
  - Validation: unit test — written file permissions match; a world-writable parent directory is
    refused with a named error, not silently accepted

## Slice 2: Socket client and server

- [ ] 2.1 `packages/opencode/src/peer/claude/socket.ts`: UDS client — connect, send the
      confirmed auth-then-message frame pair, handle connection-refused (target unreachable) and
      timeout distinctly.
  - Validation: unit/integration test against a local test listener
- [ ] 2.2 `socket.ts`: UDS server — bind at the registered `messagingSocketPath`, accept
      connections, validate the presented auth token against the local key file, decode frames via
      `codec.ts`, reject on token mismatch without leaking whether the target session exists.
  - Validation: integration test — correct token accepted, wrong token rejected, malformed frame
    rejected, all without crashing the listener
- [ ] 2.3 `socket.ts`: a liveness probe (bare connect-and-close), matching the confirmed behavior
      of real `ListAgents`/`SendMessage` — used before claiming a registered peer is reachable.
  - Validation: unit test — a registered-but-not-listening socket is reported unreachable, not
    merely "registered"

## Slice 3: Sidecar process and lifecycle

- [ ] 3.1 `packages/opencode/src/peer/claude/sidecar.ts`: a minimal, standalone entry point — on
      start, registers itself (Slice 1.4) under its own real PID and a fresh peer token, binds
      the socket (Slice 2.2), and proxies decoded inbound messages to the real opencode session
      via the existing opencode HTTP API (same injection path `peer-messaging` already uses).
  - Validation: manual — a sidecar process started standalone registers correctly and can be
    found by `registry.ts`'s own reader
- [ ] 3.2 Session lifecycle hook: spawn a sidecar when a session opts into Claude visibility
      (lazily, on first relevant peer-tool use — not for every session unconditionally); kill and
      unregister it when the session ends or the server shuts down.
  - File: session lifecycle integration point (exact hook TBD by current session lifecycle API —
    inspect before wiring, per repo convention of verifying current APIs rather than assuming)
  - Validation: integration test — sidecar process exits and its registry/key/socket files are
    removed when the owning session ends
- [ ] 3.3 Startup crash-recovery pass: on opencode server start, remove any sidecar registration
      under `~/.claude/sessions/` (or `$CLAUDE_CONFIG_DIR/sessions/`) whose PID is no longer a
      running process — mirrors the tolerance real Claude Code's own registry must have for dead
      entries.
  - Validation: unit test — a registration with a dead PID is removed; a live one is untouched

## Slice 4: Adapter — extend `peer-messaging`, not a parallel tool

- [ ] 4.1 Add `harness: "opencode-skein" | "claude-code"` to `Peer` in
      `packages/opencode/src/session/peers.ts` (currently implicit-only, per `peer-messaging`
      Slice 1.1's note that this was deferred until a second harness existed).
  - Validation: `bun run typecheck`
- [ ] 4.2 `packages/opencode/src/peer/adapter.ts`: resolve Claude-Code targets by reading the
      registry (Slice 1.3), probing reachability (Slice 2.3), and projecting them into the same
      `Peer` shape `resolveMessageTargets` produces — so `send_peer_message`'s resolution logic
      does not need to know which harness a target belongs to.
  - Validation: unit test — a Claude registry entry projects into a valid `Peer`
- [ ] 4.3 `send_peer_message` (`packages/opencode/src/tool/send-peer-message.ts`): route delivery
      through the Claude socket client (Slice 2.1) when the resolved peer's harness is
      `claude-code`, instead of the local `promptOps` injection path.
  - Validation: `bun test test/session/prompt.test.ts` still green; new test for a Claude-Code
    target delivery path (mocked socket, not a real Claude process, for the unit-test tier)

## Slice 5: Priority and busy/idle

- [ ] 5.1 Decode and preserve `priority` (`now`/`next`/`later`) through the adapter; confirm no
      code path lets `priority` affect permission evaluation — this must be checkable by reading
      the permission-evaluation call sites, not just by absence of a bug report.
  - Validation: unit test / static check — priority value has no branch reaching `Permission.evaluate`

## Slice 6: Diagnostics

- [ ] 6.1 Extend `peer-messaging`'s (or add alongside it) diagnostic surface with Claude-specific
      detail: sidecar registration state, last probe result, and the specific named error
      conditions from `findings.md`'s catalogue rather than a generic failure message.
  - Validation: manual — each named error condition produces its own distinct message

## Slice 7: Conformance and security tests

- [ ] 7.1 Unit tests: registry parsing/writing, codec round-trip, envelope sanitize/parse,
      key-file hashing, name/PID resolution — per proposal.md's testing section.
- [ ] 7.2 Security tests: forged token, stale/reused PID, `procStart` mismatch, world-writable
      runtime directory, symlinked socket/registry path, oversized frame, malformed NDJSON,
      attempted envelope-injection message.
- [ ] 7.3 Optional, manually-run conformance suite against a real stock Claude Code install —
      record the tested version (mirrors `findings.md`'s "Claude Code version tested: 2.1.261").

## Slice 8: Verification

- [ ] 8.1 `bun run typecheck` and `bun test test/peer/ test/tool/ test/session/` green.
- [ ] 8.2 Live check, following the same pattern as this spike but as a real, shipped feature
      (not a throwaway): a real opencode-skein session's `send_peer_message` reaches a real
      Claude Code session via `ListAgents`, and a real Claude Code `SendMessage` reaches a real
      opencode-skein session — both directions, cleaned up afterward if any test artifacts remain.

> Unchecked items above: see Disposition in proposal.md (2026-09-18).
