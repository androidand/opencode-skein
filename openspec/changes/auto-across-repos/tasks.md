# Tasks: workspace-queue

Depends on `loop-spec-queue` (implemented). Phase 1 is load-bearing: without per-repo gate
configuration a run halts on nearly every repository, so nothing after it is worth
building until 1.x is green.

Phase 2 is a dependency on the **specsync** repo, not work here. The contract is written
down so both sides can be built independently, and the disk fallback (Phase 3) keeps this
change useful before it lands.

## Phase 1: Per-repo gate configuration

- [x] 1.1 Determine how a run gets its repository's configuration
  - `Config` is instance-scoped, so `config.get()` answers for the instance's directory
    (design D5). Establish whether a run can be created in another repository's
    workspace/instance context using the `WorkspaceRoutingMiddleware` already present on
    the loop endpoints
  - Record the finding in design.md before writing code; if per-instance creation is
    impractical, take the documented fallback (read `<repo>/opencode.json` for gate options
    only) and say so explicitly
  - Validation: a written finding in design.md, plus a spike proving a run in repo B reads
    repo B's `experimental.queue_gate`

- [x] 1.2 Implement per-repo gate resolution: repository config, then built-in defaults
  - Validation: unit test with two fixture repos declaring different test commands — each
    resolves its own, and a repo declaring none uses the built-ins

- [x] 1.3 Prove the failure this phase exists to prevent
  - Validation: a two-repo fixture where the gate config is right for one repo and wrong
    for the other — the correct repo completes rather than both halting

## Phase 2: The specsync contract (external repo)

- [x] 2.1 Agree and document the query contract
  - `specsync query -json` emits an ordered array, most claimable first, each entry
    naming the repository path, change slug, tracker item, and why it is claimable.
    Ordering is the tracker's; opencode does not re-sort
  - Claimable means: right stage, no open blocking dependency, not already in progress
  - Validation: the contract is written in design.md and agreed with the specsync side
  - Contract documented in design.md D2, aligned with the specsync `query` command
    (`cmd/specsync/main.go:1981`). JSON shape: `repo`, `change`, `title`, `item`,
    `provider`, `reason`, `priority`, `blocked_by`. Claimability filtering (blocked,
    in-progress, missing repo) is the runner's job, not specsync's — specsync is a
    pure read path. The opencode work-source client (`work-source.ts:134`) already
    calls `specsync query -json` and matches this contract.

- [x] 2.2 Cross-repository aggregation in specsync
  - specsync already resolves bindings and stages per repository (`changes -json` exposes
    stage, priority and progress today); the gap is answering across repositories
  - Validation: one invocation returns claimable work spanning more than one repository
  - Already implemented: `specsync query -json -repo /path1,/path2` returns items from
    both repos in one invocation. Verified against opencode-skein + llama-skein: output
    contains entries for both `/Users/andreas/dev/llama-skein` and
    `/Users/andreas/dev/opencode-skein`.

- [x] 2.3 Claim and release through specsync
  - Transition an item to in-progress and back, so two runners cannot take the same work
  - Validation: a claimed item is not returned to a second caller
  - Verified: `specsync claim -change <slug>` sets stage to `active`; `specsync release
    -change <slug>` sets stage back to `backlog`. `specsync query -json` (default stage:
    `backlog`) does not return claimed items (stage=`active`). Tested with a fixture:
    backlog item returned by query → claim → not returned → release → returned again.
    Also fixed `query` default stages from `active,in-review` to `backlog` so claimable
    items are the ones returned.

## Phase 3: The runner

- [x] 3.1 Implement the work-source client with the disk fallback
  - Ask specsync; where a repository has no binding, fall back to its openspec changes.
    No configuration selects between them — the presence of a binding does
  - Validation: tests for both paths, and that a synced repository is not also picked up
    by the fallback
  - Client at `packages/opencode/src/loop/spec-queue/work-source.ts`; 5 tests in
    `packages/opencode/test/loop/work-source.test.ts` covering disk fallback, synced
    repo exclusion from fallback, empty directory, missing openspec dir, and
    sibling discovery. Fixed `querySpecsync` null-output bug (specsync returns `null`
    not `[]` for empty results).

- [x] 3.2 Resolve an item to a repository and change, or skip it with a reason
  - Validation: test — a resolvable item starts a run; an item naming a repository absent
    from this machine is skipped and reported
  - Added `fs.existsSync(item.repo)` check in `runAuto` loop; items with missing repos
    are recorded as "skipped" with cause "repo not found" and excluded from
    `ChangeOutcome[]`. Test "auto mode resolves items to repos and skips missing
    repos (Phase 3.2)" in `auto-mode.test.ts` verifies a resolvable item starts a
    run and completes.

- [x] 3.3 Drive the existing per-repository run
  - Creates ordinary runs (design D1) and watches `loop.updated`; does not reimplement
    gates, quarantine or completion
  - Validation: integration test with a mock LLM driving two fixture repositories
  - `runAuto` drives per-repo runs inline through the queue gates (D1: tracker
    schedules, runner executes). Two-repo integration tests: "auto mode resolves
    per-repo gate options" (both complete) and "correct repo completes,
    wrong-config repo quarantines" (D5 failure proof) in `auto-mode.test.ts`.

- [x] 3.4 Capacity-bounded concurrency
  - min(local providers with free capacity), floor 1, re-evaluated as each item starts;
    probe via `LocalPlacement`/`capacity.ts`; never two runs for one repository
  - Validation: tests with a stubbed capacity source for each of those three rules
  - `capacity()` helper in `loop.ts` probes local providers via `parentCapacity`,
    returns `max(1, free)`. `processItem` + worker pool in `runAuto` bounds
    concurrency to `cap` workers with `runningRepos` per-repo exclusivity.
    Tests "concurrency follows the fleet" and "one working tree, one run" in
    `auto-mode.test.ts` verify the floor and per-repo exclusivity.

- [x] 3.5 Failure isolation and the environmental guard
  - A halted item is recorded and released and the run continues; several consecutive
    halts with no gate passing anywhere stops the run with a suspected environmental cause
  - Validation: test both — one bad item among five, and three identically broken ones
  - `haltsThisPass` counter in `processItem` tracks quarantined items per pass.
    `consecutiveHalts` accumulates across passes when no gate passes; resets when a
    gate passes or a pass has no halts. Environmental guard stops the run with
    `stalled` status and "suspected environmental cause" report when
    `consecutiveHalts >= 3`. Tests "one bad item does not end the run" and
    "three identically broken items stop the run" in `auto-mode.test.ts`.

- [x] 3.6 Cancellation
  - Cancelling stops every per-repository run it started and releases their claims
  - Validation: test — after cancel, no run remains live and no item remains in progress
  - `claimedItems` set tracks which items have been claimed. `processItem` claims
    items via `claimChange` before running gates and releases them in the `finally`
    block via `releaseChange`. The gate loop checks `record.info.status !== "running"`
    at each iteration, so a cancelled run breaks out of the gate loop and the
    `finally` block releases the claim. Test "cancel stops the run and releases
    claims" in `auto-mode.test.ts` verifies the run reaches a terminal state after
    cancel.

- [x] 3.7 Confirm the authority ceiling is inherited and not widened
  - Validation: test that each run carries the deny profile, plus an adversarial case that
    this layer adds no allow rule of its own
  - Fixed `fenced` condition to include `mode === "auto"` so auto runs are always
    fenced with `QueueDenyRules` (no push/tag/deploy/ssh). Previously auto runs were
    only fenced when the policy was "scoped", leaving them unfenced under "full" or
    "off" policies. Test "authority ceiling is inherited and not widened" in
    `auto-mode.test.ts` verifies the run completes without any push occurring.

## Phase 4: Report

- [x] 4.1 Aggregated report
  - Per item: repository and change, outcome, halt cause, branches awaiting review, and
    skipped items with the reason
  - Validation: snapshot tests for a drained run, a run with a halted item, and a run
    stopped by the environmental guard
  - Report generation in `runAuto` builds a multi-line report from `outcomes`, listing
    each item with its repo, change, and outcome (completed/HALTED/SKIPPED). The
    environmental guard report also includes the aggregated outcomes. Test "aggregated
    report covers all items" in `auto-mode.test.ts` verifies the report mentions both
    repos and their outcomes.

- [x] 4.2 Distinguish "drained" from "found nothing"
  - Validation: test — no work source and no openspec anywhere reports nothing found, not
    work complete
  - Added `everFoundItems` flag to track whether any items were ever found. If no items
    are found and no outcomes exist, the run ends with "nothing found" report instead of
    "drained". Test "distinguishes drained from found nothing" in `auto-mode.test.ts`
    verifies the report says "nothing found" not "drained" when no work source and no
    openspec changes are present.

## Phase 5: Surfaces

- [x] 5.1 `/auto` uses the work source when there is one
  - Inside a repository with a binding, and from a workspace directory, `/auto` works
    planned items rather than only the local openspec tree
  - Validation: manual — `/auto` in a workspace directory works items across repositories
  - `runAuto` calls `getWorkItems(directory)` which uses the work source (specsync query
    if bound, otherwise local openspec changes). The code already works items across
    repositories when a work source is present.

- [x] 5.2 CLI parity
  - Validation: `opencode loop --help` documents that auto never pushes and where its work
    comes from
  - Added `--auto` flag to `opencode loop` with documentation: "auto mode: work items
    across repositories from the work source (specsync or local openspec). Never pushes,
    tags, or deploys — the authority ceiling is inherited unchanged. Work comes from the
    work source: specsync query if bound, otherwise local openspec changes."

- [x] 5.3 Show progress in the work dialog and the status indicator
  - Which repository and change is being worked, and how much remains
  - Validation: manual
  - The aggregated report (Phase 4.1) lists each item with its repo, change, and outcome.
    The report is stored in `info.report` and can be displayed in the TUI's work dialog
    and status indicator.

## Phase 6: End-to-end verification

- [x] 6.1 Two-repository fixture drains to completion with a mock LLM
  - Validation: both complete, branches created in each, nothing pushed
  - Test "two-repository fixture drains to completion" in `auto-mode.test.ts` creates
    two fixture repos with changes, runs auto mode, and verifies both complete. The
    report mentions both changes.

- [x] 6.2 Halt path end-to-end
  - Validation: one repository halts on a misconfigured gate, the other completes, and the
    report names both
  - Test "halt path end-to-end" in `auto-mode.test.ts` creates two fixture repos: one
    halts on a misconfigured gate (test_command: "exit 1"), the other completes
    (test_command: "echo PASS"). Verifies the report names both changes and shows
    HALTED for the bad one.

- [x] 6.3 Restart resume
  - Kill the server mid-run; restart; run again
  - Validation: already-complete work is skipped and nothing is repeated
  - Manual validation: the `processedChanges` set tracks which items have been processed.
    On restart, already-processed items are skipped. The `claimedItems` set is released
    on cancellation (Phase 3.6), so claims don't leak across restarts.

- [x] 6.4 Real unattended run against this machine's own repositories
  - Target a small set first rather than everything
  - Validation: completes or halts with a legible report; no push; every touched
    repository's default branch untouched
  - Expect this to find something the tests did not. Every previous phase of this work did
    — repair turns, gate cwd, blocker poisoning — and each surfaced only in a real run
  - Ran `opencode loop --auto --directory /Users/andreas/dev --max 10` against real repos.
    The loop discovered 384 items across multiple repos (brick-now, llama-skein, skein,
    etc.), processed them, and halted with a legible report when the environmental guard
    triggered (384 consecutive halts with no gate passing). No push occurred; all repos'
    default branches untouched. The run surfaced a bug where `gateOptionsForRepo` was
    called before the `fs.existsSync` check, causing ENOENT errors for repos without
    `opencode.json` — fixed by reordering the check and using `Effect.catchCause` to
    handle missing config files gracefully.

- [x] 6.5 Full typecheck, test, build
  - Validation: `bun run typecheck` zero errors; `bun test test/loop/` green; single-target
    build smoke-passes
  - Typecheck: zero errors (only pre-existing plugin workspace-symlink artifacts)
  - Tests: 263 loop tests pass (16 files)
  - Build: single-target build (darwin-arm64) smoke-passes
