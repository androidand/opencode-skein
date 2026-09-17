# Send messages to Claude Code peers over its local socket protocol

**Depends on `claude-code-peer-source`.** Seeing peers comes first and is independently
useful; this change is the part that carries risk, and it is separated so that risk cannot
contaminate the roster.

**Status: outbound shipped; inbound (Phase 3) explicitly greenlit and in progress (2026-09-17),
superseding this section's earlier "deferred"/"not sanctioned" language — see `tasks.md`'s
Phase 3 for the current, accurate state.** Phase 0's spike passed (GO). Outbound messaging
(Phase 1) is implemented and live-tested against this machine's real Claude Code sessions —
`packages/opencode/src/peer/claude/{registry,codec,client,resolve}.ts`, wired into
`send_peer_message`, on by default (`OPENCODE_DISABLE_CLAUDE_CODE_PEER_MESSAGING` opts out).

Inbound was originally deferred pending its own go-ahead, per the reasoning below (still the
right reasoning — it's why this is called out explicitly rather than silently proceeding).
The user gave that explicit go-ahead on 2026-09-17 ("It is not bigger, let us add it now"),
so Phase 3 is now underway: a per-session sidecar process, real registration/socket/protocol
handling, all tagged `managedBy: "opencode-skein"` in `~/.claude/sessions/` so opencode-skein's
own writes are always distinguishable from and never overwrite a real Claude Code session
(see `sidecar-registry.ts` and Phase 3.0 in `tasks.md`). This *is* still "a write into another
tool's state directory," now done deliberately and with an explicit safety contract rather
than being avoided. The original reasoning for deferring — a persistent extra process per session, a bigger
separately-reviewable commitment — is exactly why it's tracked here in detail rather than
assumed safe by default. **Phase 3 now works end-to-end**, verified against a real running
`opencode serve` process (see `tasks.md` 3.1/3.2): a real session gets a real sidecar, a real
Claude-shaped socket message reaches it, and lands as a synthetic prompt on the real session.
On by default as of 2026-09-17 (`OPENCODE_DISABLE_CLAUDE_CODE_PEER_MESSAGING` opts out).

**The sidecar is settled, not provisional (2026-09-18).** A proposal to replace it with
in-process registration was tested and rejected on evidence: Claude keys discovery on the
`<pid>.json` filename, so one process has exactly one reachable identity, and the user's
requirement is that every session be reachable. A dedicated real process per top-level
session is therefore what the protocol permits, not a workaround. The full protocol — with
that rule first and the spike as its evidence — is now written down as the
`local-agent-peer-protocol` capability in this change, so a third harness can implement it.

**The socket-path risk flagged by review was real, and is now fixed and verified.** The
sidecar originally registered under `/tmp/opencode-cc-socks/`, not one of the root prefixes
findings.md recorded Claude actually validating peer addresses against. Confirmed live: that
registration never appeared in `claude agents --json` at all — silent exclusion, not a
refusal. Fixed by moving to `/tmp/cc-socks` (the darwin root; Linux's
`$XDG_RUNTIME_DIR/cc-socks` equivalent is not yet handled). Then verified against **real,
unmodified Claude Code tools** — not the hand-rolled test client used everywhere above — this
session's own `ListAgents` found the sidecar within 4 seconds, and `SendMessage` to it
delivered successfully and landed as a real prompt on the real opencode session, with correct
sender attribution. Phase 3's core mechanism is no longer just internally consistent; it works
against the real thing.

**A shutdown gap found in the same pass, now fixed at the source.** Neither a graceful stop
(`stopAllSidecars()`'s finalizer never fires on a real `SIGTERM` — `serve.ts` has no signal
handler wired to interrupt the Effect scope) nor the next-boot orphan sweep (which explicitly
skips any registration whose pid is still alive) reclaimed a sidecar whose parent died without
signalling it — `Process.spawn` children outlive their parent by default. That made a killed
server leave a live "ghost peer": still discoverable, still able to authenticate a connection,
silently dropping whatever it received. Fixed by having the sidecar detect its own orphaning
(a changed `ppid`, checked every 2s) and self-terminate/self-unregister — this covers a
graceful stop, `SIGTERM`, `SIGKILL`, and a hard crash with one mechanism, independent of
anything the parent does. Verified live (a real `SIGKILL` to a real running server, confirmed
self-cleanup within ~1s) and covered by an automated regression test.

## Why

With the roster in place, the human still routes every cross-agent question by hand: read
one terminal, retype the answer into another. The agents can see each other and cannot
speak. The asymmetry is the point of friction — a skein session that knows
`fieldforms-be` exists and is idle still cannot ask it what shape the endpoint landed in.

## What is actually there

Observed on this machine, 2026-09-11, Claude Code v2.1.268. **All of it is undocumented
and private.** It is recorded here as findings, not as a contract:

- Each session listens on a unix socket, `messagingSocketPath` in
  `~/.claude/sessions/<pid>.json`, typically `/tmp/cc-socks/<pid>.sock`, mode 0600.
  Other permitted roots are `/private/tmp/cc-socks*`, `/run/user/<uid>/cc-socks` and a
  Termux path.
- Auth is a bearer token in `~/.claude/sessions/<pid>.<sha256-of-canonical-socket-path>.key`,
  as `{"peerToken":"<32 hex>","procStart":…,"pidDomain":…}`. The first frame written to
  the socket is `{"type":"auth","token":"<peerToken>"}`.
- The registry advertises `peerProtocol: 1` and a `peerFeatures` string array
  (observed: `notify_idle`, `reply_across_default_dirs`, `artifact_yield`).
- Addresses are validated against `^(?:uds|bridge|did):…`. **`bridge:` is a first-class
  scheme**, which suggests non-Claude peers reached through a bridge are an anticipated
  case. Whether it is usable from outside is exactly what Phase 0 must answer.

## What Changes

### Phase 0 first: a spike on `bridge:`

Before any implementation, establish what a non-Claude process may actually do:

1. Whether a skein instance can be addressed as a `bridge:` peer, and what registration
   that requires.
2. Whether Claude Code sanctions third-party writes into `~/.claude/sessions/`.
   **Assume not until shown otherwise.**
3. The message framing and its reply semantics.

Three outcomes, decided before code is written:

- **Bridge works** → skein registers as a bridge peer; inbound and outbound both follow,
  and Claude sessions see skein sessions as ordinary peers. This is the goal.
- **Outbound only** → implement sending, and say plainly that inbound is not available.
- **Neither** → archive this change. Do not ship a half-working inbound path; an agent
  that believes it can be reached and cannot is worse than one that knows it cannot.

### Outbound messaging, if the spike allows it

A client that resolves a peer to its socket, reads the token for that exact socket path,
sends the auth frame, then the message. Gated by `experimental.claude_peer_messaging`,
**default off**, following the `agent_worktree_isolation` precedent for changes that reach
outside the process.

Hard-gated on `peerProtocol === 1`. Any other value refuses with a diagnostic naming the
observed value and the version this was written against. **The failure mode must be a
clear refusal, never a best-effort guess at a changed wire format.**

When messaging is available for a peer, `canPrompt` is published `true` for that peer;
otherwise it stays `false`. The roster must not advertise a capability it cannot perform.

### What may be sent

The constraint from `agent-coordination-bus` applies in full, and is the reason this
change is narrow: **structured, verifiable facts with a stated source.** "endpoint
`POST /x` merged, response shape attached", "suite S failed, exit 1, output attached",
"I am working slug Y in worktree Z". Not "I think we should refactor the parser".

That proposal's analysis is the governing one here: when agents exchange free-form
reasoning, one agent's speculation becomes another's premise, the group converges on a
confident conclusion nobody had evidence for, and the agreement itself reads as
corroboration. Enforce the constraint in the tool's own description and message shape,
not only in prose — the description is what the model actually reads.

## Capabilities

### MODIFIED Capabilities

- `agent-presence`: control capabilities may be published `true` for reachable peers.

### New Capabilities

- `agent-messaging`: outbound structured messages to peer agent sessions on this host.

## Non-Goals

- No broadcast and no bus. Point-to-point to a named peer only. A bus is
  `agent-coordination-bus`, still gated.
- No claiming, locking or work assignment. Messaging is not consensus; see
  `provider-slot-leases`.
- No free-form agent conversation, and no relaying of transcripts.
- No cross-host messaging. Local sockets only.
- No modification of Claude Code, and no plugin or hook installed into it.
- No writes into `~/.claude/` unless Phase 0 establishes that as sanctioned.

## Risks

- **The protocol is private and can change in any release.** This is the defining risk and
  it cannot be mitigated away, only contained: experimental flag, default off, hard
  version gate, and a roster that is unaffected when messaging breaks.
- **Peer tokens are credentials.** They must be read at the moment of use, never logged,
  never written to disk by skein, never placed in a model's context, and never included in
  an error message or a spec.
- **Sending to the wrong session.** Pids are reused. Validate `procStart`/`pidDomain` from
  the key file against the live process before sending.

## Impact

- New: a peer messaging client and a tool exposing it, both behind one flag.
- Changed: capability publication in the presence source.
- If Phase 0 says no, the impact is one archived proposal and a documented finding.

## Disposition (2026-09-18)

**Shipped.** Shipped both directions via the sidecar (on by default). 2.2 done 2026-09-18 (`canPrompt` = alive + messaging enabled); 3.3 moot (inbound exists); 4.1 verified live 2026-09-17; 4.2 covered by the protocol-version unit test.
