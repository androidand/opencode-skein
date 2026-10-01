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
- [x] 1.3b Cross-platform confirmation: macOS `osascript`, Windows PowerShell `MessageBox`
      (default No, text via environment), Linux `zenity` then `kdialog` only when
      `DISPLAY`/`WAYLAND_DISPLAY` exists, then a typed confirmation on `/dev/tty` (`CON` on
      Windows), else refuse. Windows skips the uid/mode checks on the grant file (meaningless
      there) and finds the parent process through CIM instead of `ps`. All branches are unit
      tested with a fake runner and mutation-checked. NOT verified on real Windows or Linux
      desktops (only macOS is available here): task 4.3 below is the live check. Dialog strength
      differs: a shell can drive an X11 or Windows dialog without extra rights, so there it
      stops the ordinary case only. Open: the sidecar and Claude registry paths (`/tmp/cc-socks`,
      `~/.claude/sessions`) are Unix-shaped, so whether A2A itself runs on Windows is a separate
      question this change does not answer.
- [x] 1.4 opencode leads: `opencode lead set --session <exact id or pid>`. Ancestry cannot find an
      opencode session (the sidecar is a child process; the shell tool carries no session id), so
      the user names it and the confirmation dialog states which session. A TUI `/lead` command
      would need a server route plus SDK regeneration; deferred until `project-server` gives
      sessions a server to ask. Following a lead is `experimental.follow_lead: true` in config
      (no `/follow` yet).

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

- [ ] 4.0b Residual (reported by the peer on #99 Phase 2): a model shell can reach `opencode lead set` through `echo lead | xargs opencode set`-style shapes because the keyword arrives at runtime, so no deny pattern sees it. Credential stripping does not help (no credentials involved). The human-presence confirmation is therefore the real barrier; the shell deny is only a second layer.
- [ ] 4.0 Verified 2026-10-01 against the live registry: a grant stores `uds:<messagingSocketPath>`, which is byte-identical to the `from` of real inbound messages, and `claudePidOf` extracts the right pid. (Fixture-only tests could not have shown a format mismatch.)
- [ ] 4.1 Real two-session test: lead assigns, follower acts without asking its user.
- [ ] 4.2 Negative controls live: third session forges a lead message; grant expiry; `/lead off`.
- [ ] 4.3 Run `opencode lead set` once on a real Windows machine and a real Linux desktop
      (GNOME with zenity, KDE with kdialog) and on a headless Linux box (must refuse); record
      the result.
