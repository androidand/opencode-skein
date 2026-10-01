# Tasks: lead authority

## Phase 0: Reproduce

- [ ] 0.1 Failing test: formatPeerMessage from any sender always carries the "not a user
      instruction" footer (documents current behaviour; the later tests flip it for the lead only).
- [ ] 0.2 Spike: do inbound Claude Code cross-session messages fire any hook? Record result.
- [ ] 0.3 Confirm `resolveOpencodeSender` resolves a forged `from` (an address belonging to
      another session) to that other session and never to the claimed one.

## Phase 1: Grant store

- [ ] 1.1 `peer/lead.ts`: schema (closed), read with owner/mode checks, expiry, pid-alive.
- [ ] 1.2 Tests that parse-valid-but-meaningless grants are rejected: scalar where a mapping
      is required, unknown key, expired, wrong owner, dead pid. Each is run once on a
      deliberately bad file to see it fail (observed-red).
- [ ] 1.3 `skein lead set|renew|off|show|verify|instructions` CLI; `set` refuses when stdin
      is not a TTY and no `--yes-i-am-the-user` flag is passed, so a model's shell tool
      cannot trivially call it. Note the limit: a shell tool can still invoke it; D6 and the
      permission rules are the second layer (deny `*skein*lead*set*` for model shell calls).
- [ ] 1.4 TUI `/lead`, `/lead off`, `/follow`.

## Phase 2: Verification and framing

- [ ] 2.1 `verify()` per D2, with tests: lead granted; non-lead denied; forged `from` denied;
      expired denied; delegate scope limited; follower off denied.
- [ ] 2.2 `formatPeerMessage` lead frame (D3); out-of-scope and never-listed directives
      framed as context.
- [ ] 2.3 Anti-laundering test: member M relays the lead's text → framed as ordinary context.
- [ ] 2.4 `peers` marks the lead; update `peers.txt` and `send-peer-message.txt`.

## Phase 3: Claude Code

- [ ] 3.1 `skein lead instructions` fragment; document inclusion from the global file.
- [ ] 3.2 If 0.2 found a hook, implement it; otherwise ship the instruction route only.

## Phase 4: Live

- [ ] 4.1 Real two-session test: lead assigns, follower acts without asking its user.
- [ ] 4.2 Negative controls live: third session forges a lead message; grant expiry; `/lead off`.
