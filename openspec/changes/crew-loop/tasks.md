# Tasks: crew loop

## Phase 0: Spike without new code (two sessions, this repository)

- [x] 0.1 Start two `/loop --queue` runs in two checkouts of this repository
      and observe the collision `QueueActiveError` prevents: which change each
      picks, whether both push `loop/<slug>`.
      Observed: first loop picks the alphabetically first eligible change
      (cursor sorts by priority, then creation date, then slug); sets
      `currentChange` and `currentGate` on its info record. A second queue
      loop in the same directory is refused with `LoopQueueActiveError`
      carrying the first loop's ID and directory. Both would share the same
      working tree and fight over the cursor. Test added to
      `test/loop/queue-mode.test.ts` ("task 0.1: first queue picks the
      earliest eligible change, second is refused with QueueActiveError").
      219 loop tests pass.
- [x] 0.2 Run two plain sessions, hand-simulate claims by message ("I take
      X"), and record where coordination breaks: mid-turn messages, no board,
      no resume of the other's branch. Write the observations into
      `findings.md`.
      Three breakages confirmed (findings.md §Observation 2): (1) inbound
      peer messages are delivered as a competing prompt turn — the loop's
      foreign-turn guard skips its own iteration, so the claim message wins
      and the loop's work is lost that tick; (2) no shared board or inbox —
      loop state is per-process in-memory `Ref<Map>`, no `claims` table, no
      `inbox` field on `Loop.Record`; (3) no worktree resume API —
      `Worktree` has `create`/`list`/`remove` but no "attach to existing
      branch+gate" method, so a killed member's branch/gate/position is
      unrecoverable by another member.
- [x] 0.3 Confirm `peer-conversation-reliability` Phase 0 is merged (return
      address, truthful tool text) so a spike member can actually answer a
      peer.
      Confirmed merged into `dev` as `c2feec678b9` ("fix: peer-conversation
      reliability — reachable, answerable, loop-free A2A messaging (#91)").
      `returnAddressFor` in `src/peer/route.ts:34` provides the return
      address; `fromAddress` is included in outbound messages (line 179).
      The branch `fix/peer-conversation-reliability` was merged via PR #91.

## Phase 1: Claims

- [x] 1.1 Add the `claims` table and migration with the partial unique index
      on (projectID, slug) where `releasedAt IS NULL`, including `providerID`
      and `modelID` so the board doubles as a capacity map.
      Done on branch `crew-loop/claims` (not merged — adds a table to the
      shared session database for a feature still at proposal stage; that is
      a product decision, not a code-readiness one). Migration registered
      as `20260919055032_add_claims.ts` in the working tree; `schema.json`,
      `migration.gen.ts`, `schema.gen.ts` updated. `ClaimKind` and
      `ReleaseReason` defined in `packages/core/src/loop/sql.ts`. 7 tests
      pass including two added for a review finding: heartbeat on an
      already-released claim now fails with ClaimReleasedError instead of
      succeeding silently, and release is idempotent (a second release does
      not overwrite the first release's timestamp or reason).
- [x] 1.2 `loop/crew/claims.ts`: claim, heartbeat, release, listLive,
      listAbandoned; unit tests for atomic claim and stale detection.
      `Claim.Service` exposed in `packages/opencode/src/loop/crew/claims.ts`;
      `ClaimID`, `ClaimInfo`, `CreateClaimInput` types exported.
      `packages/opencode/test/loop/crew/claims.test.ts` has 7 passing tests.
- [x] 1.3 Queue cursor skips slugs with a live claim; queue mode records a
      claim on pick and heartbeats each iteration; releases on completion or
      quarantine. Remove the one-queue-per-directory refusal for crew mode
      only. Implemented in `loop.ts`: `resolveQueue` now takes a
      `claimedSlugs` set; `runQueue` resolves the project, lists live claims,
      skips claimed slugs, records a claim before each change, heartbeats each
      iteration, and releases on completion/quarantine. Migration and schema
      registered. All 205 loop tests pass.
- [x] 1.4 Board derivation `loop/crew/board.ts` with tests over fixture
      openspec trees and claim rows. `deriveBoard` returns own/live/abandoned
     /review/integrate/triage/decide/unclaimed sections; `renderBoard` emits
      plain text for the brief. `resolveQueue` now actually filters by
      `claimedSlugs` (was a no-op before). 218 loop tests pass.

## Phase 2: Inbox

- [x] 2.1 `Loop.inbox(loopID, message)` alongside `steers`; durable copy as a
      synthetic session message.
      `InboxEntry` type added with `at`, `from` (harness/id/name), `mode`
      (notify/request), and `text`. `Record_` gains an `inbox: InboxEntry[]`
      field initialised to `[]`. `Loop.inbox` appends to the in-memory inbox
      and writes a durable synthetic `SessionV1.User` message with a
      synthetic text part to the loop's session. Empty text and terminal-loop
      inputs are silently dropped. Test added to
      `test/loop/queue-mode.test.ts` ("task 2.1: inbox appends to the record
      and writes a durable synthetic session message"). 220 loop tests pass.
- [x] 2.2 Route inbound peer messages to a running or paused loop's inbox in
      `lifecycle.ts` and `send-peer-message.ts`; fall back to prompt when no
      loop owns the session. Test both paths.
- [x] 2.3 Drain the inbox into the brief at the top of the next iteration;
      emit `loop.updated` so the TUI badge can show unread count.
      Added `inbox` field to `BriefInput` in `brief.ts`; `buildBrief` renders
      drained messages before the next unchecked task. `queueTurn` in
      `loop.ts` drains the inbox (copies entries, clears the record) and
      calls `emit(id)` before each iteration. Tests added to
      `test/loop/spec-queue.test.ts` (brief rendering) and
      `test/loop/queue-mode.test.ts` (inbox acceptance + event emission).
      61 loop tests pass.

## Phase 2a: Route work to warm capacity

- [x] 2a.1 Expose the routing decision (`design.md`, "Routing a piece of
      work") as a function over the peer roster and `LocalPlacement.hostCapacity`,
      unit-tested for: warm member available, only cloud available, only a free
      host available, nothing free.
      `route()` in `packages/opencode/src/loop/crew/route.ts`; 9 tests in
      `packages/opencode/test/loop/crew/route.test.ts` covering all four
      decision branches plus edge cases (unreachable host, most-free-first).
- [x] 2a.2 Make the crew brief state the routing order explicitly, with the
      current fleet join inlined so a member sees who holds what.
- [x] 2a.3 Promote the pool-overflow path in `task.ts` from "every host full"
      fallback to the normal route when a warm member is idle, behind the
      existing `experimental.peer_delegation` switch.
- [ ] 2a.4 Verify on the real fleet that a crew of N members on N hosts does
      not spawn subagents that queue.

## Phase 3: Crew brief and command

- [x] 3.1 `/loop --crew` and `/crew` in the TUI and CLI arg parser; crew mode
      implies queue mode plus claims and inbox.
- [x] 3.2 Crew brief composition per `design.md`, with the charter; snapshot
      tests of the brief for a fixture board.
- [x] 3.3 Empty-board outcome with interval backoff; not counted as a stall.
- [ ] 3.4 Claim, handoff, and blocker announcements sent as `notify` to live
      members; guard: one announcement per event, none for heartbeats.

## Phase 4: Worktree per claim and merge-back

- [ ] 4.1 Create a worktree via `Worktree` on implement claim; run gates in
      it; record branch and worktree on the claim.
- [ ] 4.2 Driver opens a PR after the ladder completes (`gh pr create`), or
      falls back to an `integration` branch when no remote/`gh`.
- [ ] 4.3 Review items: reviewer persona in a detached worktree at the PR
      head; verdict posted; NEEDS_WORK reopens implement with the review text.
- [ ] 4.4 Integrate items: merge when approved and green; rebase-on-conflict
      path with the test gate; cleanup and archive after merge.
- [ ] 4.5 Abandoned claims: resume from recorded branch/worktree/gate; test a
      killed member's change being finished by another.

## Phase 5: Intake and human control

- [ ] 5.1 `/idea <text>` creates `intake-<slug>/proposal.md`; triage items on
      the board; triage and planner personas ported from the `skein-*`
      command bodies into `.opencode/agent/`.
- [ ] 5.2 `origin: crew` in `.openspec.yaml` makes a change ineligible until
      the human clears it.
- [ ] 5.3 `/crew` status view (board and roster) and `/crew nudge <text>`.
- [ ] 5.4 Decide items rendered from `.skein/blocker.md`.

## Phase 6: Claude Code members

- [ ] 6.1 Delegate review or a task slice to an idle Claude peer with a claim
      recorded on its behalf; release on reply or deadline.
- [ ] 6.2 Use `notify_when_idle` toward Claude members instead of polling.

## Phase 7: Live verification

- [ ] 7.1 Three members (two opencode, one Claude Code) on this repository's
      real backlog for one evening; record claims, handoffs, merges, and every
      place a member stopped for the wrong reason.
- [ ] 7.2 Token and iteration cost per member per hour, and the idle backoff
      behaviour when the board empties.
- [ ] 7.3 Decide from the evidence whether the charter, priorities, or
      StaleAfter need changing; only then consider `specsync`
      (`-repo androidand/opencode-skein`).
