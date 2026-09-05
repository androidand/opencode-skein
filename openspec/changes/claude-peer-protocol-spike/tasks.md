# Tasks: claude-peer-protocol-spike

## Slice 0: Ground truth

- [x] 0.1 Record installed Claude Code version (`claude --version`) and platform (macOS/Linux) —
      every finding below is scoped to this exact version.
  - Done 2026-09-05: 2.1.261, darwin (macOS). See `findings.md`.
- [x] 0.2 Read `PeterSR/claude-code-socket-transport` — **not needed in practice**: this
      machine's own live registry (six real concurrent sessions) was fully self-explanatory and
      directly inspectable, and gave exact, verified answers the reference implementation could
      only have offered as a starting hypothesis. See `findings.md` for what was verified
      firsthand instead.
- [x] 0.3 Read-only inspection of real local Claude session/registry/socket state on this machine.
      Never mutated live files during inspection.
  - Done 2026-09-05. Full schema, permissions, and hashing scheme recorded in `findings.md`.

## Slice 1: opencode/test process → stock Claude

- [x] 1.1 / 1.2 Subsumed by Slice 2: a genuine `SendMessage` call's real wire frames were
      captured verbatim by a disposable listener (see Slice 2), which is the same evidence Slice
      1 would have produced from the sending side. Not separately re-run as a standalone
      hand-rolled client — see `findings.md`, "Not tested in this spike".

## Slice 2: stock Claude → fake opencode peer (load-bearing)

- [x] 2.1 Registered a disposable fake peer (`claude-peer-spike-test`) using a genuine throwaway
      process (`sleep`, real PID/procStart) — done against the real, shared registry with
      explicit user permission for this specific test, after an isolated `CLAUDE_CONFIG_DIR`
      attempt hit an auth requirement that made it impractical for this narrow test. Full
      before/after cleanup verified (registry restored to exactly its prior 6-session state).
  - Validation: **passed** — unmodified `ListAgents` listed it as `interactive · idle`.
- [x] 2.2 `SendMessage` targeting the fake peer; disposable listener received and decoded the
      real frames.
  - Validation: **passed**, on the second attempt — the first attempt used a single-shot
    listener that (correctly) got treated as unreachable after `ListAgents`' own liveness probe
    consumed its one handled connection; a persistent listener then captured the full real
    auth + message frames. See `findings.md` for the exact bytes.
- [x] 2.3 N/A — 2.1 and 2.2 both passed outright; no failure to document.

## Slice 3: round trip

- [ ] 3.1 Not executed — the reply mechanism (connect to the `from` URI, present that session's
      own peer token, send the identical frame shape) is fully confirmed by Slice 2's captured
      frames, but a live reply was deliberately not sent, to limit further writes to this
      machine's live session state once the load-bearing question (Slice 2) was answered. Real
      implementation work, not a remaining spike uncertainty.

## Slice 4: opencode ↔ opencode over the same mechanism

- [ ] 4.1 Not executed. Nothing observed contradicts it — the fake peer in Slice 2 used no
      Claude-specific internals, only file/socket conventions any process (including a future
      opencode-skein sidecar) can implement identically on both ends.

## Slice 5: busy-recipient semantics

- [ ] 5.1 Not executed.

## Slice 6: findings and recommendation

- [x] 6.1 Findings and recommendation written: **GO**, with Option B (per-session sidecar
      process) identified as the correct process-identity model for opencode-skein — Option A
      (Claude's own model, confirmed 1-process-per-session) doesn't fit opencode's
      one-server-many-sessions architecture. See `findings.md`.
- [x] 6.2 All spike artifacts (disposable listener script, registry/key/socket files, throwaway
      process) fully removed and verified — `~/.claude/sessions/` confirmed back to its exact
      pre-spike file count, `ListAgents` confirmed back to the exact pre-spike peer list. Nothing
      was ever added to `packages/opencode/src/`.
- [x] 6.3 `packages/opencode/src/plugin/skein-peers.ts` was already deleted in `peer-messaging`
      before this spike ran.
