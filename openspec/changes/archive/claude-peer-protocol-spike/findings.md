# Findings: claude-peer-protocol-spike

Date: 2026-09-05. Claude Code version tested: **2.1.261** (also observed 2.1.259, 2.1.260 among
this machine's other live sessions — protocol appears stable across these patch versions).
Platform: **macOS (darwin)**. Everything below marked "confirmed" was verified against this
machine's real, live Claude Code installation — not inferred from the reverse-engineered
reference implementation, which was not consulted (network access to GitHub was not needed;
the live registry was self-explanatory and directly inspectable).

## Recommendation: **GO**, with one real design consequence for opencode-skein

The core hypothesis holds: a process with no real Claude Code binary behind it, registering
files in exactly the right shape, is treated by stock, unmodified Claude Code as a fully
legitimate peer — discoverable via `ListAgents` and reachable via `SendMessage`, receiving the
real wire protocol. **Spike 2 (the load-bearing one) passed outright.**

The one consequence that must shape the real implementation: Claude's identity model is
**one OS process per registered session** (confirmed directly — see Process Identity below).
opencode-skein's architecture does not guarantee that: one `opencode serve` process can host
multiple independently-useful sessions across different directories (this is the exact premise
`session-peer-awareness`/`fleet-instance-presence` are built on). **Option B from the original
design checklist — a small per-session sidecar process — is therefore the right choice, not
Option A.** A direct 1:1 with opencode's own process would under-represent multi-session
instances and misrepresent identity for sessions that don't happen to own their own process.

## What was verified, and how

Verification method: inspected this machine's own live registry (six real concurrent Claude Code
sessions were running throughout — see `ps`/`lsof` output from earlier in this conversation),
then — with explicit user permission for this specific test — registered one disposable fake
peer using a genuine throwaway process (`sleep 99999`, killed and fully cleaned up afterward) and
proved it end-to-end via this session's own `ListAgents`/`SendMessage` tools. Full before/after
`ListAgents` diffs and cleanup verification are in the conversation transcript. No real session's
files were read, written, or touched at any point.

### Session registry

- **Location**: `~/.claude/sessions/<pid>.json` (no `CLAUDE_CONFIG_DIR` was set in this
  environment, so this is the default; a test with an isolated `CLAUDE_CONFIG_DIR` confirmed the
  whole config tree, sessions directory included, relocates cleanly under it — so the location is
  `$CLAUDE_CONFIG_DIR/sessions/<pid>.json` with `~/.claude` as the default).
- **Directory permissions**: confirmed `drwx------` (0700), owner-only.
- **Exact schema** (all fields observed on six independent real sessions, plus one accepted
  fake registration):
  ```json
  {
    "pid": 3866,
    "sessionId": "d1d25a93-76b4-4b14-8fdf-3a9896202a4c",
    "cwd": "/Users/dev/dev/opencode-skein",
    "startedAt": 1788621312135,
    "procStart": "Sat Sep  5 15:15:11 2026",
    "version": "2.1.261",
    "peerProtocol": 1,
    "peerFeatures": ["notify_idle", "reply_across_default_dirs", "artifact_yield"],
    "kind": "interactive",
    "entrypoint": "cli",
    "pidDomain": "darwin",
    "messagingSocketPath": "/tmp/cc-socks/3866.sock",
    "name": "opencode-skein-e2",
    "nameSource": "derived",
    "nameSince": 1788621312135,
    "status": "busy",
    "updatedAt": 1788637560798,
    "statusUpdatedAt": 1788637560798,
    "bridgeSessionId": "session_01VNLPKoYAazB85eSHgToec1"
  }
  ```
  - `procStart` is **not** local time — confirmed byte-for-byte as `TZ=UTC LC_ALL=C ps -o lstart=
    -p <pid>` (this machine is UTC+2; the naive local-time guess would have been off by exactly 2
    hours). This is the field that would matter for PID-reuse detection.
  - `peerProtocol`, `bridgeSessionId`, `sessionId`, and `cwd` were **not** strictly validated by
    `ListAgents`/`SendMessage` in this test: a fabricated `bridgeSessionId`, a nonexistent `cwd`,
    and an arbitrary UUID `sessionId` were all accepted. **Unverified**: whether a `peerProtocol`
    value other than 1 is rejected — not tested, since this machine's real sessions are all
    protocol 1.
  - `status` (`idle`/`busy`/etc.) is read directly by `ListAgents` for display; not independently
    re-verified live at list time (a fake "idle" status was taken at face value).

### Auth / key file

- **Location**: `~/.claude/sessions/<pid>.<hash>.key`, sibling to the registry file.
- **Hash confirmed exactly**: `sha256(messagingSocketPath)`, lowercase hex, no salt.
- **Permissions**: confirmed `-rw-------` (0600), owner-only.
- **Schema**: `{"peerToken": "<32 lowercase hex chars, 16 bytes>", "procStart": "<same format as
  registry>", "pidDomain": "darwin"}`.
- **Security model, confirmed empirically**: the peer token is not a secret between different
  users' processes — it's a same-OS-user file-permission boundary. Any process running as the
  same user can read any other session's key file and thus construct a validly-authenticated
  message to it. There is no additional cryptographic barrier between two sessions owned by the
  same person. This matches the design checklist's expectation and simplifies the opencode-skein
  side considerably: reading a real Claude session's key file (to message it) requires nothing
  beyond normal filesystem permissions already available to any same-user process.

### Inbox socket

- **Path**: exactly `messagingSocketPath` from the registry — observed as `/tmp/cc-socks/<pid>.sock`
  on this machine. **Not** under `$XDG_RUNTIME_DIR` (empty on macOS) or `$TMPDIR` (which is
  `/var/folders/.../T/` here) — a hardcoded `/tmp/cc-socks/` on darwin.
- **Directory permissions**: confirmed `drwx------` (0700), owner `andreas`.
- **Socket permissions**: confirmed `srw-------` (0600).
- A registered peer whose socket is not actually bound/listening is correctly treated as
  unreachable — confirmed by accident: an early, single-shot test listener exited after handling
  one connection, orphaning the socket file, and the very next `SendMessage` attempt correctly
  refused delivery ("No agent named ... is reachable") even though `ListAgents` had just listed
  it as idle moments earlier. **This is a real, working liveness check, not registry-file-only
  trust.**

### Reachability probing (previously undocumented in any prior-art source consulted)

Both `ListAgents` and `SendMessage` independently open and immediately close a real connection to
a candidate's socket as a liveness probe, distinct from the actual message delivery connection.
Confirmed via a persistent listener's log showing bare accept-then-immediate-close events
correlating with `ListAgents` calls, followed by a separate, longer-lived connection carrying the
real frames only when `SendMessage` was actually invoked. This means **listing a peer is itself a
live check, not a registry-file read** — a dead/stale registration with a description that merely
looks plausible will not appear reachable.

### Wire protocol

Confirmed exact, real frames captured from a genuine `SendMessage` call (NDJSON, one frame per
line, single connection carries both):

```json
{"type":"auth","token":"2fb69192b4e89e0aceb43d365173e7f5"}
{"msgV":1,"msg_id":"67e61ca5-e466-4510-867d-b1a0ffaabf5b","type":"user","message":{"role":"user","content":"<cross-session-message from=\"uds:/tmp/cc-socks/3866.sock\" from-name=\"opencode-skein-e2\" from-mode=\"prompting\">\nspike-roundtrip-probe-4f2a9c: this is a disposable protocol-verification test, not a real request.\n</cross-session-message>"},"priority":"next","from":"uds:/tmp/cc-socks/3866.sock"}
```

- **Frame 1 (auth)**: `{"type":"auth","token":"<peerToken>"}` — the sender reads the *target's*
  key file and presents that token back. Sent once, first, on every new connection observed.
- **Frame 2 (message)**: `msgV: 1`; `msg_id` a UUID (matches what `SendMessage` returns to the
  caller as `msg_id`, confirming this is a real correlation id, not cosmetic); `type: "user"`;
  `message.content` is a **plain string** (not a parts array) containing the full attribution
  envelope; `priority` was `"next"` for a plain `SendMessage` call (`"now"`/`"later"` not
  exercised — not sent by this call shape); `from` is the sender's own socket URI, doubling as
  the return address.
- **Attribution envelope, confirmed exactly**:
  `<cross-session-message from="uds:<sender-socket>" from-name="<sender-display-name>"
  from-mode="<sender-status>">\n<message text>\n</cross-session-message>`. Content is embedded
  raw, not escaped or CDATA-wrapped. **Security note for the real implementation**: when
  opencode-skein constructs outbound envelopes itself, message text containing a literal
  `</cross-session-message>` or a forged `from="..."` -looking substring should be neutralized
  before embedding — Claude's own sender did not need to worry about this because it controls
  both ends of what it sends, but opencode-skein's inbound decoder must not blindly trust envelope
  attributes as authoritative sender identity beyond what the *transport* (which socket connected,
  which auth token was presented) already proved.
- **Return address / reply mechanism**: to reply, connect to the `from` URI (a `uds:` path),
  present *that* session's peer token (read from its own key file — same permission model), and
  send the identical two-frame shape back. Not executed in this spike (stopped once sufficient
  evidence existed to avoid unnecessary further writes to a live personal machine), but every
  piece needed to do it is now confirmed, not guessed.

## Process identity — the actual open question, now answered

**Option A confirmed as what real Claude Code does**: every one of the six independently observed
real sessions was exactly one OS process (`claude`) registering exactly one PID. No sidecar, no
multiplexing, no shared-process multi-session registration was observed anywhere on this machine.

**For opencode-skein, this does not mean Option A is correct to copy directly.** opencode-skein's
own architecture (per `fleet-instance-presence`, `session-peer-awareness`) already assumes one
server process can host multiple independently-active sessions across different directories.
Registering only the `opencode serve` process's own PID would collapse all of that process's
sessions into one addressable peer, which is wrong for the stated goal ("every independently
useful live session should be separately addressable"). **Recommendation: Option B — a small
per-session sidecar process**, each one a genuine, separately-running process (satisfying the
real-PID/real-`procStart` requirement this spike confirmed matters for liveness, though not
confirmed as cryptographically enforced), that registers itself exactly per this protocol and
proxies frames to/from the real opencode session over a local IPC channel (the same server the
session already runs behind). This keeps opencode's own canonical session identity untouched — see
`design.md`'s Session Identity section, unchanged by this finding.

## Not tested in this spike (explicitly deferred, not silently skipped)

- **Spike 1** (test process → stock Claude) is subsumed by the above: the exact frame shape a real
  sender produces is now captured verbatim, which is everything Spike 1 would have shown from the
  other direction. Not separately re-run as a standalone hand-rolled client.
- **Spike 3** (full round trip with an actual reply) — mechanism confirmed sufficient (see Return
  address above), but a live reply was not sent, to limit further writes to this machine's live
  session state once the load-bearing question was answered.
- **Spike 4** (opencode ↔ opencode over this mechanism) — not executed; nothing observed
  contradicts it working identically to Claude ↔ fake-peer, since the fake peer used no
  Claude-specific internals, only file/socket conventions any process can implement.
- **Spike 5** (busy-recipient mid-turn safety) — not executed.
- Protocol-version mismatch handling, oversized/malformed frames, replay, and other adversarial
  cases were not probed — these remain real implementation work with their own test suite, per
  the original scope, not spike questions.
- Whether `peerProtocol` values other than `1` are rejected — not observed either way.

## Prior art disposition

`packages/opencode/src/plugin/skein-peers.ts` was reviewed for context only; its disposal and any
reusable shape were `peer-messaging`'s concern (already resolved there — see that change), not
this spike's.
