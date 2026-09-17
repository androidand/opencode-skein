# Tasks: claude-peer-messaging

## Phase 0: Spike — decide before building

- [x] 0.1 Determine whether a non-Claude process can be addressed as a `bridge:` peer,
      and what registering as one requires
  - Validation: a written finding with evidence, and a go/no-go recommendation
  - Done in `claude-peer-protocol-spike` (2026-09-05): confirmed via a disposable test
    peer. See that change's `findings.md`.
- [x] 0.2 Determine whether third-party writes into `~/.claude/sessions/` are sanctioned
  - Default answer is no; record what changed the answer if it changes
  - Validation: written finding
  - Decision (2026-09-17): treated as **not** sanctioned for a persistent, always-on
    registration. This change ships outbound-only and writes nothing under
    `~/.claude/` — see the Phase 3 note below.
- [x] 0.3 Establish framing and reply semantics after the auth frame
  - Validation: a documented request/response transcript against a throwaway session
  - Done in the spike; reply mechanism confirmed but not exercised live (see
    `findings.md`, "Return address / reply mechanism").
- [x] 0.4 **Decision gate.** Record the outcome — bridge / outbound-only / archive — and
      stop here if it is archive
  - Validation: the decision is written into this proposal before Phase 1 starts
  - Decision: **outbound-only**, this pass. See `proposal.md`'s status line.

## Phase 1: Outbound client

- [x] 1.1 Resolve peer → socket path → matching `<pid>.<sha256>.key`
  - Validation: unit test over a fixture registry, including a socket with no key
  - Done: `src/peer/claude/registry.ts`, `test/peer/claude/registry.test.ts`.
- [x] 1.2 Validate pid identity via `procStart`/`pidDomain` before connecting
  - Validation: test that a reused pid with a mismatched start time is refused
  - Done: `verifyProcessIdentity` in `registry.ts`, tested against a real live pid
    (this process) and a deliberately wrong `procStart`.
- [x] 1.3 Connect, send the auth frame, send the message, handle the reply
  - Validation: integration test against a live local Claude session
  - Outbound half done and tested against a fake listening socket
    (`test/peer/claude/client.test.ts`) with real frame bytes asserted. "Handle the
    reply" is N/A without a sidecar (Phase 3, deferred) — there is no inbox to
    receive one on yet; the tool description states this plainly.
- [x] 1.4 Hard-gate on `peerProtocol === 1`; refuse anything else with a diagnostic
      naming the observed value
  - Validation: test with a registry entry advertising protocol 2
- [x] 1.5 Never log, persist, or surface a peer token
  - Validation: test asserts no token appears in logs, errors, or serialized state
  - Done: the token is read in `registry.ts`, used once in `client.ts`'s frame
    construction, and never placed in a returned result, error message, or log line.

## Phase 2: Gating and exposure

- [x] 2.1 `disableClaudeCodePeerMessaging` in `effect/runtime-flags.ts`
      (`OPENCODE_DISABLE_CLAUDE_CODE_PEER_MESSAGING`), on by default as of
      2026-09-17 (was default-off behind an experimental flag)
  - Validation: with the flag set, no socket is opened and `canPrompt` stays false
- [ ] 2.2 Publish `canPrompt: true` only for peers actually reachable now
  - Validation: a peer whose socket is gone publishes false
  - Deliberately not done: `canPrompt` still means "can be prompted and can reply",
    which this outbound-only channel cannot honor — flipping it to `true` would
    advertise a capability that isn't real. Revisit once/if Phase 3 lands.
- [x] 2.3 Expose a tool whose description constrains content to structured facts with a
      stated source, and rejects free-form reasoning
  - Validation: the description states the constraint; review confirms the message shape
    carries a source field
  - Done: `send-peer-message.txt` states the outbound-only limitation and the
    structured-fact framing is inherited from the existing peer-messaging tool
    description (short, point-to-files coordination, not free-form chat).

## Phase 3: Inbound — now in progress (2026-09-17), per-session sidecar

- [x] 3.0 Cleanup/attribution safety, built first since it's the load-bearing
      correctness requirement for everything else in this phase
  - Every file opencode-skein ever writes into `~/.claude/sessions/` is tagged
    `managedBy: "opencode-skein"` — the entire safety contract: nothing here
    ever touches a file lacking that marker, and a stale sweep only removes a
    marked entry whose pid is confirmed dead.
  - Done: `src/peer/claude/sidecar-registry.ts`
    (`writeSidecarRegistration`/`removeSidecarRegistration`/`sweepStaleSidecars`/
    `listManagedPids`), `test/peer/claude/sidecar-registry.test.ts`.
  - Also done: `presence-claude.ts` excludes our own managed pids from the
    Claude-peer roster, cross-referencing the raw registry file directly
    (`claude agents --json` silently drops unknown fields like `managedBy`,
    so filtering can't rely on the CLI path alone).
- [x] 3.1 Register the skein instance as a bridge peer
  - Validation: a skein session appears in a Claude session's peer list
  - Done: `src/peer/claude/sidecar-server.ts` (registration + real UDS server
    + protocol handling), `sidecar-entry.ts` (the actual spawned script — a
    genuinely separate process, satisfying Claude's real-pid/real-procStart
    requirement), `sidecar-manager.ts` (spawns/tracks/stops sidecars from the
    main server process, only when `which("claude")` finds a real install).
    End-to-end tested by spawning the real entry script and connecting to it
    exactly as a real Claude peer would (`test/peer/claude/sidecar-e2e.test.ts`).
  - Design departure from "HTTP callback to the owning server": the sidecar
    talks to its parent over stdout only (one NDJSON event per line), not
    HTTP. This avoids inventing any new auth surface (no server port/password
    to hand the child) — the parent already has full access to the real
    session via the Effect services that spawned it.
- [x] 3.2 Accept, authenticate and route inbound messages to the right session
  - Validation: a message sent from Claude reaches the addressed skein session
  - Done for accept/authenticate/decode: real auth-token check (wrong token
    ⇒ connection refused, tested), envelope stripped via
    `codec.ts#parseEnvelope`, forwarded to `sidecar-manager.ts`'s injected
    `deliver(sessionID, text)` callback — tested end-to-end
    (`test/peer/claude/sidecar-manager.test.ts`) with a real spawned sidecar
    and a real socket message.
  - Done: `src/peer/claude/lifecycle.ts` — a new Effect service
    (`ClaudeSidecarLifecycle`, registered in `effect/app-runtime.ts`'s
    LayerNode graph alongside the other fork services) that subscribes to
    `Session.Event.Created`/`Deleted`, calls `ensureSidecar`/`stopSidecar`
    accordingly, and wires `deliver` to `SessionPrompt.Service.prompt(...,
    synthetic: true)` — the same injection primitive `send_peer_message`
    uses. Inert only when `disableClaudeCodePeerMessaging` is set.
  - Verified: `bun typecheck` clean; the broad session/effect test suites
    pass unchanged with this new node in the boot graph — a circular or
    broken layer dependency would have failed layer construction for all of
    them, not just this feature's own tests.
  - **Real bug found by a live smoke test (2026-09-17), root-caused and
    fixed.** `server/routes/instance/httpapi/server.ts` builds its own,
    separate `LayerNode.group([...])` — the actual root the HTTP server
    boots from — distinct from `effect/app-runtime.ts`'s `AppLayer`.
    `ClaudeSidecarLifecycle.node` had only been added to the latter, so a
    session created over the real HTTP API never reached it. Fixed by adding
    the node to `server.ts`'s own graph too (same place `AutoMode.node`/
    `Loop.node`/`SideQuestion.node` are already joined for the same reason).
  - A second real bug surfaced once the event reached the listener:
    `SessionPrompt.Service.prompt(...)` requires `InstanceRef` (the resolved
    project instance), which a tool call normally inherits from the request
    that invoked it — a background event listener has no such context.
    Fixed by resolving it explicitly via `InstanceStore.Service.load({
    directory: info.directory })` and providing it with
    `Effect.provideService(InstanceRef, instance)` around the `prompt` call.
  - **Verified end-to-end against a live `opencode serve` process, for
    real**: booted the server with the flag on, created a real session over
    HTTP, connected to the resulting sidecar's real socket exactly as a real
    Claude peer would (raw auth + message frames), and confirmed via the
    HTTP API that the real message part
    (`"hello from a real smoke test round 2"`, wrapped in the peer-message
    provenance envelope) landed on the real session. This is no longer a
    hypothesis — inbound genuinely works end to end with the flag on.
  - Also added while fixing: subagent/child sessions (`info.parentID` set)
    no longer get their own sidecar — one per top-level session only; the
    sidecar's self-reported sender name now reaches the injected message
    (previously hardcoded to "Claude Code")
    so a multi-peer setup can tell which Claude session actually sent it;
    `sidecar-manager.ts` now pipes and logs the child's stderr instead of
    discarding it, since a sidecar that fails silently at startup was
    exactly the kind of thing that made this bug hard to see.
  - **A third real bug, found and fixed (2026-09-17): the socket directory
    was invisible to real discovery.** The sidecar registered under
    `/tmp/opencode-cc-socks/`, not one of the roots findings.md recorded
    Claude actually validating peer addresses against. Confirmed live: a
    perfectly well-formed registration there never appeared in
    `claude agents --json` at all — not a refusal, silent exclusion. Fixed
    by moving the default to `/tmp/cc-socks` (the darwin root, shared safely
    since every socket is pid-named and pids are unique). Linux's
    equivalent (`$XDG_RUNTIME_DIR/cc-socks`) is not yet handled.
  - **Verified against real, unmodified Claude Code tools, not a hand-rolled
    client**: after the fix, this session's own `ListAgents` listed the
    sidecar within 4 seconds of session creation, and this session's own
    `SendMessage` to it returned `success: true` and the message landed on
    the real opencode session with the correct sender identity attached.
    This is the test the proposal's "one real risk" section called for —
    it now passes.
  - **A fourth gap, found during this same verification pass and now fixed
    properly rather than patched around.** The `stopAllSidecars()`
    graceful-shutdown finalizer does not fire on a real `SIGTERM` to the
    server (`serve.ts`'s `Effect.never` has no signal handler wired to
    interrupt the Effect scope) — confirmed live. Worse, a peer review
    caught that `sweepOrphanedSidecars()` on next boot does **not** cover
    this case either: it only reclaims a registration whose pid is also
    dead (`sweepStaleSidecars` explicitly skips a live pid), and
    `Process.spawn` children don't die with their parent. So a killed
    server left a live "ghost peer" sidecar — still discoverable, still
    able to authenticate a connection, with no parent left to turn what it
    receives into a real prompt — which fails as silent message loss, not a
    visible error, and would sit there indefinitely (a SIGTERM handler in
    `serve.ts` alone couldn't have fixed the SIGKILL/hard-crash case
    either). Fixed at the source instead: the sidecar detects its own
    orphaning (its `ppid` changing from what it was at spawn — the OS
    reparents an orphan to pid 1 or the nearest subreaper) via a 2s poll,
    and self-terminates and self-unregisters the moment it notices,
    covering graceful stop, `SIGTERM`, `SIGKILL` and a hard crash with one
    mechanism, in `sidecar-entry.ts` itself — no dependency on the parent
    signalling it at all. Verified live: hard-`SIGKILL`ed a real running
    server with a real sidecar registered, confirmed the sidecar's `ppid`
    became `1` within 1s and the process and its registration were both
    gone within that same window — and covered by a new automated
    regression test (`sidecar-e2e.test.ts`, orphans a real sidecar via an
    intermediary process that exits immediately, confirms self-cleanup).
  - **A fifth bug, the real cause of a red error on every actual TUI launch
    (2026-09-17), root-caused and fixed.** Turning peer messaging on by
    default meant the sidecar started spawning on ordinary use for the
    first time — and it crashed immediately every time, because
    `sidecar-manager.ts` spawned it as `bun run <path-to-sidecar-entry.ts>`,
    a real file on disk in dev but **not shipped at all** in a compiled
    single-file binary (confirmed: `find dist -iname '*sidecar*'` — nothing).
    Fixed by running the sidecar as a hidden `debug claude-sidecar-entry`
    subcommand of the same executable instead (`cli/cmd/debug/
    claude-sidecar-entry.ts`), resolved correctly in both dev (`bun run
    <src/index.ts's own path>`, computed from this file's own location, not
    `Bun.main` — which reflects whatever launched the *current* process,
    e.g. the test runner under `bun test`, not the real entry point) and
    compiled (the executable itself, no wrapping needed).
  - A second, related bug surfaced immediately once the subcommand ran at
    all: `index.ts` has an unconditional `finally { process.exit() }` after
    `cli.parse()` resolves — fine for one-shot commands, fatal for
    something meant to run forever. The sidecar's handler used to return
    once setup finished, so the whole process was force-killed moments
    after registering (registry file present, socket already gone — the
    exact symptom observed). Fixed the same way `serve.ts` does for the
    same reason: `runSidecarEntry` now never resolves on its own.
  - Verified against the actual compiled binary, not source: rebuilt with
    `bun run build:local`, ran it as a real server, created a real session,
    confirmed a real sidecar registered with no error, messaged it with a
    real `SendMessage`, confirmed the message landed on the real session,
    and confirmed clean teardown. `sidecar-manager.test.ts` now exercises
    this exact subcommand path too (previously it inadvertently tested a
    different, source-only code path).
  - **Two more bugs caught live by the user (2026-09-17), fixed.** First: the
    `peers` tool never showed Claude Code peers at all — the cross-owner
    merge only ever existed in the `/agents` HTTP endpoint and the CLI, not
    in the tool an agent actually reaches for when asked "who else is
    around?". Fixed: `tool/peers.ts` now merges in `fetchClaudeAgentRecords`
    results, states whether each is currently messageable, and
    `peers.txt`'s description (which still said "in this directory") is
    rewritten to match the cross-directory reality.
  - Second: `send_peer_message`'s "not found" message still said "No
    session in this directory matches" — stale text from before the
    cross-directory widening — and, worse, when
    `disableClaudeCodePeerMessaging` was off it never even looked up
    whether a matching Claude session existed, so "doesn't exist anywhere"
    and "exists but messaging is disabled" were indistinguishable. Fixed:
    the Claude lookup now always runs (gated only by the presence flag),
    and a found-but-disabled Claude peer gets its own clear message and
    metadata reason (`messaging-disabled`) instead of a generic
    "not-found".
- [x] 3.4 **Architecture settled by evidence (2026-09-18): the sidecar stays,
      and is the only mechanism that can satisfy "every session reachable."**
  - A rewrite was proposed to drop the sidecar: register the TUI/`run`
    process itself (one PID, one focused session — the TUI's server is a
    Bun Worker *thread*, same PID, so one window really is one process). It
    would have removed every process-lifecycle failure this phase hit. It
    would also have made exactly one session per window reachable, and the
    user's requirement is that *all* sessions are.
  - So the load-bearing question was tested rather than argued: can one
    process register several peer entries (same live pid, one socket each)?
    Spike: two registrations from one process, `<pid>.json` and
    `<pid>-b.json`, both with live sockets and correct per-socket key files.
    Real `ListAgents` listed the first and **not** the second. Claude keys
    discovery on the `<pid>.json` filename; one process has at most one
    identity. Recorded as the first requirement of the new
    `local-agent-peer-protocol` spec.
  - Consequence: a reachable conversation needs its own real pid — a
    dedicated process per session is not an artifact of earlier assumptions,
    it is what the protocol permits. In-process rewrite cancelled. The
    (now working, compiled-binary-verified) sidecar remains the single
    uniform mechanism; eager spawning per top-level session is correct for
    the stated requirement (subagents still excluded).
  - Also rejected, with the reason on paper: an MCP-over-HTTP inbound path.
    The default TUI serves at `http://opencode.internal` over worker RPC
    with no TCP port, so that path would need a port per window plus port
    discovery — the registry problem relocated — and loses native
    `ListAgents`/`SendMessage` symmetry.
  - Follow-up, not done: sidecar startup evaluates the whole CLI's static
    imports (~200ms, ~40MB per session). A first-position fork import in
    `index.ts` using top-level await could branch to the sidecar before the
    rest evaluates. Deferred — a memory-leak investigation the user raised
    takes priority over startup shaving.
- [ ] 3.3 If Phase 0 said outbound-only, document the absence here and close the phase
  - N/A — proceeding with inbound, not stopping at outbound-only.

## Phase 4: Verify

- [ ] 4.1 End-to-end with the real working set: a skein session messages a Claude peer
      working a sibling worktree of the same change
  - Validation: the message arrives, the reply is received, the roster stays correct
- [ ] 4.2 Confirm a Claude Code upgrade that changes the protocol degrades to a refusal
      and leaves the roster working
  - Validation: simulated by forcing the version gate to fail
