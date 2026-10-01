# Tasks: lead authority

## Phase 0: Reproduce

- [ ] 0.1 Failing test: formatPeerMessage from any sender always carries the "not a user
      instruction" footer (documents current behaviour; the later tests flip it for the lead only).
- [ ] 0.2 Spike: do inbound Claude Code cross-session messages fire any hook? Record result.
- [ ] 0.3 Confirm `resolveOpencodeSender` resolves a forged `from` (an address belonging to
      another session) to that other session and never to the claimed one.

## Phase 1: Grant store

- [x] 1.1 `peer/lead.ts`: schema (closed), read with owner/mode checks, expiry, pid-alive.
- [x] 1.2 Tests that parse-valid-but-meaningless grants are rejected: scalar where a mapping
      is required, unknown key, expired, wrong owner, dead pid. Each is run once on a
      deliberately bad file to see it fail (observed-red).
- [x] 1.3 `opencode lead set|off|show|verify|instructions` CLI (`cli/cmd/lead.ts`). The caller is
      identified by process ancestry, so a command cannot name a session it is not running
      inside. FINDING: a model's shell in the same session has the same ancestry as the user's
      `!` command and DID resolve to this session in a smoke test (grant written to a throwaway
      state dir). So `set` also needs a human-presence check: native dialog on macOS, else a
      typed confirmation on the controlling terminal, else refuse; `--no-confirm` is the
      explicit unsafe opt-out. The terminal check is a speed bump only (a model can allocate a
      pty); the dialog is the real barrier. Remaining: default-deny `lead set` for model shells
      in opencode sessions and in queue/auto-mode (`QueueDenyRules`), and a recommended deny
      rule for Claude Code settings (operator applies).
- [ ] 1.4 TUI `/lead`, `/lead off`, `/follow`.

## Phase 2: Verification and framing

- [x] 2.1 `verify()` per D2, with tests: lead granted; non-lead denied; forged `from` denied;
      expired denied; delegate scope limited; follower off denied.
- [x] 2.2 `formatPeerMessage` lead frame (D3). Wired on the sidecar path (Claude and cross-process
      opencode senders). NOT yet wired on the in-process `send_peer_message` path (no Config
      there) — lands with `project-server` in-server delivery. Out-of-scope/never-listed framing
      is not done: it cannot be decided from text, so it belongs to the permission layer.
- [x] 2.3 Anti-laundering test: member M relays the lead's text → framed as ordinary context.
- [ ] 2.4 `peers` marks the lead; update `peers.txt` and `send-peer-message.txt`.

## Phase 3: Claude Code

- [x] 3.1 `opencode lead instructions` fragment; document inclusion from the global file.
- [ ] 3.2 If 0.2 found a hook, implement it; otherwise ship the instruction route only.

## Phase 4: Live

- [ ] 4.1 Real two-session test: lead assigns, follower acts without asking its user.
- [ ] 4.2 Negative controls live: third session forges a lead message; grant expiry; `/lead off`.
