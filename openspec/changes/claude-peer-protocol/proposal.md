# Native cross-session peer messaging between opencode-skein and Claude Code

## Status: unblocked — `claude-peer-protocol-spike` reported GO on 2026-09-05

The load-bearing spike (a fake, disposable peer registered against a real, unmodified Claude Code
installation) passed outright: `ListAgents` listed it, `SendMessage` delivered real, decodable
wire frames to it. Full protocol details — registry schema, key-file hashing, socket path/perms,
NDJSON frame shapes, the attribution envelope, the return-address mechanism — are verified,
not assumed, in `claude-peer-protocol-spike/findings.md`. Read it before touching this change;
it is the source of truth this proposal is built on.

## Why

opencode-skein sessions are invisible to Claude Code's own `ListAgents`, and Claude sessions are
invisible to opencode-skein's `peers`/`send_peer_message` (`peer-messaging`) unless someone opens
two terminals and manually relays. The spike proved the fix does not require Claude to install
anything, run an MCP server, or run a bridge daemon: opencode-skein can become a **real** peer on
Claude's own local mechanism.

## What Changes

### 1. Process identity: a per-session sidecar (spike's Option B, not Option A)

Real Claude Code registers exactly one PID per session (confirmed). opencode-skein's own
architecture does not guarantee that — one `opencode serve` process can host several
independently-active sessions across directories (`fleet-instance-presence`,
`session-peer-awareness`). Collapsing all of a server's sessions into one Claude-visible peer
would misrepresent them. Each opencode-skein session that opts into Claude visibility gets its
own small, genuinely separate **sidecar process** — spawned when the session starts (or lazily on
first use of the peer tools), registering under its own real PID, and proxying frames to/from the
real opencode session over the opencode HTTP API it already exposes (the same mechanism
`peer-messaging` uses internally). Killed and unregistered when the session ends or the server
shuts down; a crash-recovery pass removes any sidecar registration whose PID is no longer running,
on the same principle real Claude Code's own registry must tolerate (per the spike's confirmed
"reachability is actively probed, not registry-trusted" finding).

### 2. Compatibility boundary — an adapter, not a rewrite

A `peer/claude/` module owns everything Claude-protocol-shaped: registry read/write, key-file
hashing (`sha256(messagingSocketPath)`, confirmed), the UDS client and server, the NDJSON codec,
and attribution-envelope construction/parsing. The rest of opencode-skein — specifically
`peer-messaging`'s `Peer`/`PeerMessage` model and `send_peer_message` tool — gains
`"claude-code"` as a second reachable harness through this adapter. No new tool, no parallel
`list_agents`/`send_message` pair.

### 3. Outbound: opencode-skein → Claude

Resolve a Claude peer from its registry entry (read-only, same-user file permissions — confirmed
sufficient, no additional secret exchange needed), probe reachability the same way `ListAgents`
does (connect-and-close) before claiming a target is available, then send the real two-frame
shape: `{"type":"auth","token":"<their peerToken>"}` then the message frame with a fresh `msg_id`,
`priority`, `from` set to the sidecar's own socket URI, and `message.content` wrapping the text in
the confirmed `<cross-session-message from="..." from-name="..." from-mode="...">` envelope —
**with the message text sanitized first**: a literal `</cross-session-message>` or a
`from="..."`-shaped substring in the payload must not be able to forge envelope structure or
sender identity, a risk the spike's findings flagged but did not need to solve (Claude's own
sender controls both ends of what it sends; opencode-skein's sender does not get that luxury when
the text originates from model output).

### 4. Inbound: Claude → opencode-skein

The sidecar's socket server validates the presented auth token against its own key file, decodes
the message frame, strips and parses the attribution envelope, and — critically — **never treats
the parsed `from`/`from-name` as ground truth beyond "which authenticated socket connection sent
this"**: envelope attributes are for display/context, transport identity (the connection that
presented a valid token) is what provenance is actually keyed on. The resulting message is
injected into the real opencode session the same way `peer-messaging` injects same-machine peer
messages — same provenance discipline, same "this is agent context, not a permission grant"
posture, extended to a message that happens to have arrived from a different harness.

### 5. Priority and busy/idle

`priority` (`now`/`next`/`later`) is decoded and preserved but affects **scheduling only, never
authorization** — restated explicitly because it is the one field in this whole protocol capable
of being misread as an escalation mechanism. A session mid-turn is not interrupted; a message
arriving then is queued the same way `peer-messaging` already refuses same-directory delivery to
a literally busy target rather than risking corruption — Claude-sourced messages get the identical
treatment, not a more permissive one.

### 6. Diagnostics

Extend whatever `peer-messaging` already exposes (or add alongside it) with Claude-specific
detail on request: sidecar PID/socket/registration state per session, last reachability probe
result, and the specific reasons `findings.md`'s error catalogue calls for ("peer protocol version
2 is unsupported", "registered but socket unreachable", "runtime directory has insecure
permissions", etc.) rather than a generic "send failed".

## Conformance and security testing

Per the original request's detailed scope, still binding: unit tests for registry parsing/writing,
the NDJSON codec, key-file hashing, envelope construction *and* sanitization, name/PID resolution;
a manual/optional conformance suite runnable against a real stock Claude Code install (recording
the tested version, mirroring how `findings.md` records 2.1.261); security tests for a forged
token, a stale/reused PID, a `procStart` mismatch, a world-writable runtime directory, a symlinked
socket or registry path, an oversized frame, malformed NDJSON, and an attempted envelope-injection
message. None of this is optional polish — the spike's findings make clear the entire security
model rests on filesystem permissions and live reachability checks, both of which this
implementation must uphold at least as strictly as real Claude Code does.

## Non-Goals

- Everything the original request explicitly excluded: remote/cross-machine federation, cloud
  ChatGPT, MCP messaging, A2A, a generic distributed agent protocol, persistent message history
  service, team/task orchestration, shared memory, file transfer/attachments, broadcast channels,
  a central broker, llama-skein integration, specsync integration.
- Not a mandatory daemon — matches the spike's constraint.
- Not replacing `fleet-instance-presence`/`agent-coordination-bus` for opencode-to-opencode
  presence unless the spike's Slice 4 findings and a follow-up reconciliation decision say so.

## Dependencies

- **`claude-peer-protocol-spike`** — satisfied; findings and a GO recommendation exist.
- **`peer-messaging`** — satisfied; shipped and live-verified (same-directory `send_peer_message`
  reachable and delivering). This change extends its domain model, not a placeholder.

## Impact

- New: `packages/opencode/src/peer/claude/registry.ts` (read/write registry JSON + key file),
  `socket.ts` (UDS client + server), `codec.ts` (NDJSON frame encode/decode + envelope
  construct/parse/sanitize), `auth.ts` (token read/present/verify), `sidecar.ts` (per-session
  sidecar process entry point and lifecycle), `packages/opencode/src/peer/adapter.ts`
  (`"claude-code"` harness on `peer-messaging`'s `Peer`/`PeerMessage` model).
- Modified: `packages/opencode/src/session/peers.ts` (`harness` field on `Peer`, now genuinely
  used), `packages/opencode/src/tool/send-peer-message.ts` (resolve a Claude-Code target through
  the adapter), session lifecycle hooks (spawn/kill the sidecar with the session).
- New tests: `packages/opencode/test/peer/claude/*` (unit) plus an optional, manually-run
  conformance suite against a real stock Claude Code install.
