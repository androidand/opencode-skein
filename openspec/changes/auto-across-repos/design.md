# Design: ready-work runner

## D1 — The tracker is the scheduler; this only executes

The first draft of this change added directory scanning, a repo priority setting, a depth
knob and a least-recently-attempted ordering rule. All four are answers to "what next",
and all four already have answers on the board: Status, priority, and the links between
items — including across repositories, which the draft had written off as a non-goal.

Two schedulers is the failure mode to avoid. When they disagree — and they will, because
one is edited by humans on a board and the other lives in `opencode.json` — the run does
something nobody asked for and the fix is ambiguous. So: **no ordering logic here at
all.** Items arrive ready and in order; this executes them.

The test for any future addition: if it decides *what* or *in what order*, it belongs in
the tracker. If it decides *how the work is carried out on this machine*, it belongs here.

## D2 — The read path belongs in specsync, not in opencode

specsync already owns openspec ↔ provider translation, already resolves each change's
binding (`.specsync/board.json`: `project_id`, `item_id`, stage→Status), and already
reconciles state back into `tasks.md`. It is write-mostly only because nobody needed the
other direction yet.

Putting a GitHub Projects query in opencode would mean provider knowledge in two
codebases, two places to update when a board's Status options change, and two things to
configure. Instead specsync gains a query mode and opencode shells out to it — the same
way the queue already shells out to `specsync -change <slug>` for `--sync`.

**Contract** (specified here so both sides can be built independently):

```
specsync query -json [-repo /path1,/path2] [-stage active,in-review]
```

emits an ordered array:

```json
[{ "repo": "/abs/path/to/repo", "change": "retire-auto-reply",
   "title": "Retire the auto-reply", "item": "10", "provider": "github-projects",
   "reason": "stage=active", "priority": 2, "blocked_by": [] }]
```

Field semantics:

- `repo` — absolute path to the repository on this machine.
- `change` — the openspec change slug.
- `title` — the change's title from `openspec/changes/<slug>/proposal.md`.
- `item` — the tracker item ID from `.specsync/board.json` (e.g. `"10"` for a GitHub
  Projects item). Empty when the change has no binding.
- `provider` — the tracker provider name (`"github-projects"`, `"beads"`). Empty when
  unbound.
- `reason` — why the item is in the result set, formatted `stage=<stage>` with
  ``,blocked_by=<N>`` appended when blockers exist.
- `priority` — the change's priority (integer, nullable).
- `blocked_by` — array of blocker URLs. Empty when unblocked.

Ordering is by priority (descending), then stage order, then slug. The runner SHALL NOT
re-sort.

**Claimability filtering is the runner's job, not specsync's.** specsync returns all
changes in the requested stages, including blocked and in-progress ones. The runner must:

1. Skip items with non-empty `blocked_by` (open blocking dependency).
2. Skip items already in progress (checked via the tracker, not the local board state).
3. Skip items whose `repo` path does not exist on this machine.

This split keeps specsync a pure read path: it reports what exists and what stage each
change is in, and the runner applies the claimability rules it already owns (D4).

Items whose repository cannot be located on this machine are omitted by the runner rather
than guessed at.

## D3 — Degrade to disk, without configuration

A repository with no tracker binding still has openspec on disk, which is what the per-repo
queue already reads. So the fallback is not a mode: if specsync reports nothing for a
repository and that repository has eligible changes, the runner works them the way a
single-repo run would.

This keeps the change useful before the specsync query mode exists, and keeps it working
for repos not yet synced — without a setting to decide which behaviour applies, because
the presence of a binding is already the signal.

## D4 — Claim in the tracker, not in a lock file

Two runners, or a runner and a human, must not take the same item. The board already
models this with status, and beads additionally has gates and merge-slot for serialized
conflict resolution.

So claiming is: transition the item to in-progress before starting, release or complete it
after. A private lock file would be a second source of truth about who is doing what, and
would be invisible to the person looking at the board — which is precisely the split-brain
this change is trying not to create.

Deliberate consequence: a crashed runner leaves an item in progress. That is recoverable
by a human on the board, and preferable to a lock nobody can see. Reaping stale claims is
the tracker's concern, not this runner's.

## D5 — Per-repo gate configuration is the only new setting

`Config` is instance-scoped (`InstanceState`), so `config.get()` inside the loop service
answers for the instance's directory. One server driving thirty repositories therefore
cannot read thirty different `experimental.queue_gate` blocks by calling it.

This is load-bearing rather than cosmetic: with the wrong gate commands a run halts with
"suspected misconfigured test gate" on nearly every repository and achieves nothing.
Preferred fix is to create each queue run in the workspace/instance context for its
repository, reusing the routing already on the loop endpoints, so config resolves because
the instance *is* the repository. Fallback, if that proves impractical, is to read
`<repo>/opencode.json` for gate options only — and to say plainly that this is the one
config read that bypasses the instance.

Note this is not scheduling configuration. It describes how to run tests in a given
checkout, which no tracker knows or should know.

**Finding (2026-10-03):** Per-instance creation is impractical for the auto runner. The
loop service is a single Effect service with one `InstanceState` keyed by the loop's own
directory; creating a second instance per item's repo would require a parallel service
graph per repo, which the current architecture does not support. The fallback is taken:
`gateOptionsForRepo` reads `<repo>/opencode.json` for `experimental.queue_gate` and falls
back to the instance config. This is the one config read that bypasses the instance —
it is explicit, scoped to gate options only, and documented here.

## D6 — Concurrency is derived, not configured

Repositories are separate working trees, so concurrency across them is safe in a way that
concurrency within one is not. The bound is what the fleet can serve: probe local provider
capacity, run that many, floor one, re-checked as each item starts. No knob, because the
honest value changes minute to minute and a configured number would be wrong most of the
time.

One run per repository at a time regardless — the queue already refuses a second run for
the same directory.

## D7 — Failure isolation

An item that halts is reported and released; the runner moves to the next. The per-repo
systemic guard still applies inside each run, and the runner adds one at its own level:
if several consecutive items halt without any gate passing anywhere, stop and report a
suspected environmental cause rather than marching through the backlog failing
identically.
