# Tasks: claude-code-peer-source

## Phase 0: Verify the source contract

- [x] 0.1 Re-verify `claude agents --json` output shape against the installed version
  - Record the version checked; the shape is a CLI contract, not a spec
  - Validation: a captured fixture committed as test data, with the version noted
  - Done 2026-09-17: re-checked against 2.1.274 (was 2.1.261 at spike time) — shape
    unchanged. Fixture in `test/agent/presence-claude.test.ts`.
- [x] 0.2 Confirm `status` semantics — specifically that an absent `status` means busy
  - Validation: observe a session mid-turn and a session at rest
  - Done 2026-09-17: live check via `presence-claude.ts` against this machine's real,
    running sessions — matched `claude agents --json` 1:1 (15/15).

## Phase 1: Widen the model

- [x] 1.1 `Owner` becomes `Schema.Literal("opencode-skein", "claude-code")`
  - Validation: `bun typecheck` — zero errors
  - Done: `Schema.Literals(["opencode-skein", "claude-code"])` in `agent/presence.ts`
    (this repo's Effect version has no variadic `Schema.Literal`).
- [x] 1.2 Decide how a Claude UUID satisfies `sessionID: SessionID`
  - Either widen the schema or carry a source-qualified id; do not coerce a UUID into
    a `ses_`-shaped string
  - Validation: a Claude record round-trips through the schema unchanged
  - Done: `Info.sessionID` widened to `Schema.String` — presence `Info` is a metadata
    projection, not the canonical session identity.
- [x] 1.3 Find and fix every consumer that assumed one owner
  - Validation: grep for the literal; `/agents`, the TUI view and the Go aggregator each
    render a foreign owner without special-casing
  - Done: only real in-repo consumer was `handlers/agents.ts`, which hardcodes
    `owner: "opencode-skein"` for its own records and simply appends Claude records
    separately — no special-casing needed. No TUI/Go consumer of `AgentPresence.Info`
    exists in this repo (grepped `packages/*` — only the handler, the schema group,
    the SDK's generated types, and tests reference it).

## Phase 2: The source

- [x] 2.1 Claude source module: run `claude agents --json`, parse, map to `Info`
  - Validation: fixture-driven unit tests, including unknown extra fields
  - Done: `src/agent/presence-claude.ts`, `test/agent/presence-claude.test.ts`.
- [x] 2.2 Fall back to reading `~/.claude/sessions/*.json` when the binary is absent
  - Validation: test with the binary unavailable and the directory present
  - Done: `fetchViaRegistry` in `presence-claude.ts`, tried when `which("claude")` is
    null or the CLI call fails.
- [x] 2.3 Absent fields stay absent; no invented `model`, `agent` or `provider`
  - Validation: test asserts the mapped record has no fabricated fields
- [x] 2.4 Control capabilities are published `false`
  - Validation: test asserts `canPrompt`/`canBtw`/`canAbort` are all false
- [x] 2.5 Never read any file under `~/.claude/` other than the session registry, and
      never read `*.key`
  - Validation: test asserts the read set; a peer token must never enter the process
  - Done: `fetchViaRegistry` filters to `*.json` only; `*.key` reads live exclusively
    in `peer/claude/registry.ts` (outbound messaging), never in this module.
- [x] 2.6 Dead pids report `unreachable` rather than disappearing
  - Validation: test with a registry entry whose pid does not exist
- [x] 2.7 A malformed or failing source yields zero Claude peers, never a failed roster
  - Validation: tests for non-JSON output, non-zero exit, and a changed shape

## Phase 3: Work identity

- [ ] 3.1 Read `specsync topology -json` and annotate peers by worktree path
  - Applies to both owners; the join is on directory
  - Validation: a skein peer and a Claude peer in sibling worktrees of one change both
    resolve to the same slug
  - Deferred: not part of this pass; the source and the `/agents` merge work stands
    on its own without it.
- [ ] 3.2 Degrade silently when specsync is absent or older than `topology`
  - Validation: peers still list with directories and no slug; no error surfaces
  - Deferred, same as 3.1.

## Phase 4: Surface

- [x] 4.1 `/agents` gains owner and slug columns; Claude peers appear inline, not in a
      separate section
  - Validation: manual check with live Claude and skein sessions running
  - Done for the owner column (Claude peers are appended into the same array the
    `agents.list` HTTP endpoint returns, `owner: "claude-code"` set). No "slug" column
    yet — that's Phase 3, deferred.
- [x] 4.2 Cache the poll for the roster read path
  - Validation: repeated reads within the window spawn one subprocess
  - Done: 2s TTL cache in `presence-claude.ts`, shared between the presence
    projection and target resolution (`peer/claude/resolve.ts`) so a burst of either
    kind of call spawns at most one `claude` process.
- [x] 4.3 Config switch to disable the Claude source
  - Validation: disabled, no Claude peers appear and nothing else changes
  - Done: `OPENCODE_DISABLE_CLAUDE_CODE_PEER_SOURCE` in `effect/runtime-flags.ts`.

## Phase 5: Verify

- [x] 5.1 Run with the human's real working set — several Claude sessions across
      worktrees plus a skein instance
  - Validation: the roster matches `claude agents --json` plus skein's own sessions,
    with no duplicates and no missing rows
  - Done 2026-09-17: `listClaudePeers` against this machine's 15 real, live Claude
    sessions matched `claude agents --json`'s own count and pids exactly.
