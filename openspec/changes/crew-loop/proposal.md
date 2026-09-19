# Crew loop: self-driving agent sessions that share one board

## Status

Exploration and planning, 2026-09-18. Local to the repository. Written in
response to the question "how do we turn peer discovery and messaging into a
team that keeps going on its own", with the previous attempt (the Go `skein`
orchestrator) as the negative example.

## Why

The first skein was a central scheduler: a YAML fleet config, a stage funnel,
agents activated as functions of the scheduler's state. It stalled in its own
routines, lost work on abandoned worktrees, could not merge, and its agents
never spoke to each other. The config was always stale because it described a
fleet from the outside.

What works today in this fork is the opposite shape, and it is why `/loop`
feels alive when the swarm did not: drive lives inside a session. The loop
service re-prompts one session from a durable record every iteration, stops
only on a completion contract or a stall guard, and, when eternal, flips into
queue mode and works the openspec backlog through an implement → test →
verify → commit gate ladder with quarantine on repeated failure
(`packages/opencode/src/loop/loop.ts`, `spec-queue/*`). The board already
exists: it is `openspec/changes/*` with `tasks.md` as the work list and
`.skein/blocker.md` as the quarantine mark. Peers can now see and message
each other, and a bounded task can be handed to an idle peer
(`peer/delegate.ts`).

Three facts stop this from being a team:

1. **One queue loop per directory.** `QueueActiveError` and the eternal
   handoff both refuse a second queue driver in the same directory, because
   two drivers would fight over one derived cursor and one working tree
   (`loop.ts:1489-1538`). So N sessions cannot work one backlog.
2. **No claims, no worktree per change, no merge-back.** The cursor is
   "first eligible change", derived each pick and never stored. The archived
   `agent-worktree-isolation` change was never wired in and was closed with
   "queue-mode auto-isolation + merge-back can be a new change". The only
   outward git action is one `git push -u origin <branch>` by the driver.
3. **Messages do not reach a working member.** An inbound peer message to a
   session that is mid-iteration starts a competing turn; the loop's
   foreign-turn guard then skips its own iteration. There is no inbox, so
   "I took X, you take Y" has nowhere to land while the receiver is busy.

"Enthusiasm" is not a property we can prompt for. Mechanically, a session
stops when its turn ends with no tool call. What looks like drive is a
next-turn source with a reason attached. The loop is that source; a
non-empty, shared, honest board is the reason. This change gives every member
the same loop and the same board, and uses peer messaging for what it is good
at, coordination, rather than as the engine.

## What Changes

### 0. The crew is the sessions holding your inference capacity

This is the premise the rest depends on, and it is where the cloud-shaped
default is wrong for this fleet.

A subagent is designed for an API where concurrency is free: spawn one per
piece of work and let the provider sort it out. Locally it is the opposite.
The llama.cpp hosts here serve one request at a time, so a subagent takes a
whole host, and if that host is not already serving the model it needs, it
must load the weights first — which is why placement scores an already-loaded
model above everything else. When every host is occupied, spawning adds no
parallelism at all; it queues, and the notes on background subagents record
exactly that happening.

A peer session is the opposite trade. It already holds its slot, its weights
are resident, its cache is warm, and it has the context of what it has been
doing. Giving it work costs one turn on capacity that is already committed.

So the crew is not "as many agents as the work suggests". It is the sessions
that hold the fleet: roughly one member per reachable host, plus cloud-backed
members (Claude Code sessions, API-backed opencode sessions), which are not
slot-bound and can absorb work that would otherwise queue. Members are
long-lived and warm. Work moves to them by message. Spawning a subagent is
the exception, taken when a host is genuinely free and the work needs a
different model than any member is holding.

`peers` now reports this directly: each host with its loaded model and which
session is working on it, and it says so when every reachable host is taken.
That join is the capacity map a member reasons from.

### 1. A crew is N sessions running the same loop, not a config

`/loop --crew` (alias `/crew`) starts a queue-mode loop that works from a
shared claims board instead of a private cursor. Membership is whoever is
running it in this project right now, as the `peers` roster already reports.
There is no fleet file to go stale. Members can be started by hand, by a
script, or by another member delegating; leaving is closing the session.
Crew size is bounded by the fleet, not by the backlog: a second member on a
host that already has one is a queue wearing a colleague's name.

### 2. Claims: the board remembers who holds what

A claim is a durable row keyed by project and change slug: holder session,
harness, display name, branch, worktree, current gate, `since`, and a
heartbeat the holder's loop refreshes each iteration. The queue cursor skips
changes with a live claim. A claim whose heartbeat is stale becomes an
**abandoned** board item: the branch and worktree are preserved, and any
member may resume it (not restart it). Completion, quarantine, or the human
releases the claim. This is the `ClaimBoard`/`ReleaseBoard` idea from the Go
skein, moved into the store every opencode process on this machine already
shares, with liveness derived from heartbeats rather than declared.

### 3. One worktree per claim, one branch per change, merge-back as work

A member that claims a change works in a worktree created by the existing
`Worktree` service, on branch `loop/<slug>` (the queue's commit gate already
names it). When the gate ladder completes, the driver pushes and opens a PR,
and the board gains **review** and **integrate** items for that change. Those
are claims like any other: a member with nothing better to do reviews
another member's PR; a member claims the integrate item, merges when review
and CI are green, and handles a conflict by rebasing on the change's own
branch. No member ever commits to the default branch directly; the deny
rules already applied to queue runs stay.

### 3a. Work goes to whoever is already warm

A member that needs something done decides in this order, and the brief says
so in as many words:

1. a member already holding the right host, with the right model loaded, who
   is idle → message it;
2. a cloud-backed member → message it, since it costs the fleet nothing;
3. a genuinely free host → spawn a subagent there;
4. nothing free → put the item on the board and carry on; do not spawn into a
   queue and do not sit waiting.

The existing pool-overflow path (`task.ts` → `peer/delegate.ts`) already
implements the tail of this: when every local host is full it hands the task
to an idle peer instead of refusing. Crew mode makes that the normal route
rather than the fallback, and makes the choice visible in the brief instead of
buried in placement.

### 4. Messages coordinate; they do not drive

Members announce claims, handoffs, and blockers with `notify`, and ask
bounded questions with `request` (from `peer-conversation-reliability`). An
inbound peer message to a session with a running loop is **not** injected as
a turn: it is appended to that loop's inbox and surfaced at the top of the
next iteration brief, next to the operator's `/nudge` steers. That closes the
foreign-turn race and matches where `steer-running-work` put delivery. A
member with no running loop still receives messages as today.

### 5. The crew brief

Every iteration's brief carries, in order: the operator's standing guidance
and steers; the inbox since the last iteration; the board (my claim, live
claims by others, abandoned items, review and integrate items, unclaimed
changes, intake stubs); the roster with status; then the change documents
and the gate instruction as today. A short **charter** states the crew's
priorities and rules: unblock others before starting new work (decide >
review > integrate > resume abandoned > implement > triage intake); claim
before touching a change; announce claims and handoffs; ask rather than
guess; never take on work a peer was denied; when the board is empty, wait
with backoff rather than invent work.

### 6. Intake: the human feeds ideas, the crew shapes them

`/idea <text>` (or dropping a file) creates `openspec/changes/intake-<slug>/`
with the idea as `proposal.md`. Intake stubs appear on the board as
**triage** items. A member that claims one runs the triage and planning
personas (the bodies of the existing `skein-triage`, `skein-architect`, and
`skein-plan-stage` commands, ported into personas in `.opencode/agent/`) and
turns it into a change with `tasks.md`, which makes it queue-eligible. A
change the crew itself proposes is marked `origin: crew` in `.openspec.yaml`
and is not eligible until the human clears it, so the crew cannot feed
itself.

### 7. Human control stays where it is

`/nudge` steers one member; `/crew nudge <text>` sends the same steer to
every member's inbox. `/crew` shows the board and roster. Pause and cancel
are per loop as today. A change that needs a human decision is quarantined
with `.skein/blocker.md` naming the question, and the board shows it as a
**decide** item addressed to the human.

### 8. Claude Code and cloud sessions as members

A Claude Code session cannot run the opencode loop, but it can hold a claim:
a member delegates a bounded item (review, a task slice) to an idle Claude
peer with the existing `[peer-task]` envelope, records the claim on its
behalf, and releases it on reply or deadline. Claude sessions reached over
Claude's own cross-session channel, including remote ones where the harness
supports it, join the same way. This is a later phase; the local crew must
work first.

## Non-Goals

- No central scheduler process and no fleet YAML.
- No new message bus; the sidecar transport and `send_peer_message` are the
  only channels.
- No automatic merge without a completed gate ladder and a review claim.
- No unattended commits or pushes to the default branch.
- No agent-proposed work becoming eligible without a human clearing it.
- No attempt to make members "feel" motivated; the design is a loop over a
  board, and it stops honestly when the board is empty.

## What is reused

- Loop service, queue mode, gates, quarantine, personas, deny rules, `/nudge`.
- `LocalPlacement` host capacity and the pool-overflow delegation in
  `task.ts`/`peer/delegate.ts`, promoted from fallback to normal route.
- The `peers` fleet join (`describeFleet`), which already answers "who is
  holding which host".
- `Worktree` service (`packages/opencode/src/worktree/index.ts`).
- Peers roster, `send_peer_message`, sidecar transport, `peer/delegate.ts`.
- The openspec tree as the board, `.skein/blocker.md` as the decide mark.
- Command bodies in `~/.claude/commands/skein-*.md` as persona source text.
- From the Go skein: claim/release semantics; nothing else.

## Dependencies

- `peer-conversation-reliability` (return address, `notify`/`request`
  modes, honest delivery states, inbound at a safe boundary). The inbox
  routing in §4 is the crew-side half of its step-boundary requirement.
- `fix-queue-branch-awareness` (active) for branch handling in queue mode.

## Impact

- `packages/opencode/src/loop/loop.ts`, `spec-queue/{queue,brief,gates}.ts`:
  claims-aware cursor, inbox, crew brief, worktree lifecycle, PR/review/
  integrate items.
- New `packages/opencode/src/loop/crew/{claims,board,inbox}.ts` and a
  `claims` table migration.
- `peer/claude/lifecycle.ts` and `tool/send-peer-message.ts`: route to a
  running loop's inbox.
- TUI `/loop --crew`, `/crew`, `/idea` commands; SDK loop args.
- `.opencode/agent/`: triage, planner, integrator personas.
- Tests: claims lifecycle, cursor skipping, heartbeat expiry, inbox drain,
  brief composition, two-member live run on this repository's backlog.
