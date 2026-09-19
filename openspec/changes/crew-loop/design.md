# Design notes: crew loop

## What "drive" is, mechanically

A session runs while its turn has tool calls. The loop supplies the next
turn; the board supplies the reason. Everything here is arranged so that the
next iteration's brief always answers "why am I here" from shared state, and
so that the honest answer "nothing to do" produces a quiet wait, not
invented work. Peer messages are inputs to that brief, not a second engine.

## The unit of a crew is a held slot

Everything below assumes one thing: a member is a session that holds inference
capacity, and capacity here is scarce and lumpy.

| | subagent | peer session |
| --- | --- | --- |
| slot | takes one, usually the host's only one | already holds one |
| weights | may force a load, evicting what was resident | resident |
| cache | cold | warm |
| context | none | knows what it has been doing |
| when every host is busy | queues, adding no parallelism | unaffected |
| addressable later | no, it ends | yes, it is still there |

That table is the whole argument for routing work by message. It also bounds
the crew: aim for about one member per reachable host, plus any number of
cloud-backed members, which cost the fleet nothing. Two members on one
single-slot host is not two workers; it is one worker and a queue.

Two facts from `local/placement.ts` sharpen this and constrain the design:

- **Residency is an absolute tier, not a bonus.** An already-loaded model
  scores `+100_000`, above every other term, precisely because a swap "evicts
  what the user (or skein) deliberately keeps loaded and costs a multi-second
  reload both ways". A crew that shuffles models across hosts spends its time
  loading weights.
- **Slot reservations are per process and in memory.** `reservations` is a
  module-level `Map<providerID, count>` with a 120 s TTL, holding a count and
  never a session id. Two opencode processes each running crew members cannot
  see each other's reservations; each sees only the host's own in-flight
  figure. So a crew spread over several processes must not rely on
  reservations for mutual exclusion — the claims board is what members
  coordinate through, and the host counts are advisory.

A member's host is already known — `Peer.provider` and `Peer.model` carry it,
and `describeFleet` joins that against `LocalPlacement.hostCapacity` to show
which session is on which host. The claim rows below record it too, so the
board is simultaneously a work list and a capacity map, and a member can see
that taking a second item would land on a host a colleague is already using.

## Coordination depends on the relationship, not on the status

One roster and one status word cannot answer "what should I do about this
peer", because the right move depends on how the two sessions are related and
on what the peer is available for. Those are two separate axes, and the code
now carries both (`session/peers.ts`).

**Relationship** — computed from the directory and the git common directory,
so every worktree of one repository shares an identity:

| relation | what is shared | the coordination that fits |
| --- | --- | --- |
| same working tree | files, index, branch | divide: agree who owns which files or task before either edits |
| same repo, another worktree | branches, tags, history, objects | synchronise: branch names, rebases, merges, pushes |
| different repository | nothing | inform: interfaces, contracts, the issue that spans both |

Only the first is a collision in the sense the original `peers` tool meant.
The third is not a hazard at all, and treating it as one is why cross-repo
work never got coordinated: there was nothing to warn about, so nothing was
said, and the two sides drifted.

**Availability** — what the peer can do for you now, which "busy" and "idle"
each split in two:

| availability | derived from | what it means for you |
| --- | --- | --- |
| free | idle and attended | can take something on |
| engaged | mid-turn | a message races the turn; delivery is refused |
| blocked | awaiting-permission, stalled | not working, but going nowhere until a human answers |
| settling | cancelling | briefly neither |
| absent | no process attending | will never answer |

The two `blocked` cases are the ones the old model hid. A session waiting on a
permission prompt reads as "not busy" and is not available; a stalled loop
reads the same and needs a human, not a colleague. Both are now stated on the
peer's own line.

### What is it busy with

Relationship and availability are computable from what the store already
holds. *What* a peer is working on is not: the roster has its title, which is
model-generated and often stale, and its branch. That is enough to spot an
overlap and not enough to decide whether to interrupt.

The missing piece is that a working session does not publish what it is doing.
The mechanism should be the session's own `metadata` record (`Session.Metadata`
is an open `Record<string, unknown>`), because it crosses processes through the
shared store and does not create the import cycle that keeps loop state out of
the peers projection today. A crew member's loop writes, each iteration:

```
metadata.activity = { what: "<change slug> · <gate>", claim: "<slug>", since: <ms> }
```

`peers` reads it if present and renders it after the title. Nothing else
changes; a session that publishes nothing reads exactly as it does now. With
it, "should I disturb this one" becomes answerable: a member three gates into
a change you do not care about is worth leaving alone, and one holding the
change you are blocked on is worth a request even though it is engaged.

### What the prior art does and does not settle

- **A2A** models the "not working, not finished" case properly:
  `INPUT_REQUIRED` and `AUTH_REQUIRED` are a distinct *interrupted* class
  alongside working and terminal, and `REJECTED` lets an agent refuse work
  outright. `contextId` is the cross-session thread that a cross-repo
  synchronisation needs. It says nothing about two agents sharing a
  filesystem — it is a protocol between remote agents, and physical
  contention is not in its model. The divide-the-work case is ours.
- **Anthropic's multi-agent write-up** answers division structurally rather
  than conversationally: the lead sets "clear task boundaries" up front,
  because vague scope made subagents duplicate each other's work. It is a
  lead-and-subagent topology; peers never negotiate. That is evidence for
  claims — exclusion by an up-front, visible allocation — over agents
  agreeing among themselves who takes what.
- **Claude Code's cross-session contract** answers "when will you be free"
  with a one-shot idle subscription and an explicit rule never to poll, and
  treats delivery as enqueue-at-the-next-turn-boundary rather than as an
  interrupt. It also reports back when a session holds or refuses a message,
  which is an availability signal we do not yet have an equivalent for.

None of the three models scarce local capacity. That, and shared working
trees, are the two things this design has to supply itself.

## Data model

### Claim

One row per (project, slug) with `releasedAt IS NULL`; a partial unique index
enforces one live holder.

```
claims
  id            text pk
  projectID     text
  slug          text
  kind          'implement' | 'review' | 'integrate' | 'triage' | 'decide'
  holderSession text        -- opencode session id, or a Claude pid string
  holderHarness 'opencode-skein' | 'claude-code'
  holderName    text
  branch        text?
  worktree      text?
  -- Which inference capacity this claim is consuming. A claim is not just
  -- work in progress, it is a slot held: two live claims naming one provider
  -- on a single-slot host are queued behind each other, not parallel.
  providerID    text?
  modelID       text?
  gate          text?       -- last gate reached, for resume
  since         integer
  heartbeat     integer     -- refreshed each iteration by the holder's loop
  releasedAt    integer?
  releaseReason 'completed' | 'quarantined' | 'abandoned' | 'cancelled' | 'human'?
```

The store is the shared SQLite every opencode process on the machine uses,
so members in different processes and directories see one board without a
service. Claude members do not read it; the member that delegated to them
writes and releases on their behalf.

### Board (derived, never stored)

```
board(projectID) =
  live      = claims where releasedAt IS NULL and now - heartbeat < StaleAfter
  abandoned = claims where releasedAt IS NULL and now - heartbeat >= StaleAfter
  unclaimed = resolveQueue(root).eligible minus slugs with a live claim
  review    = changes with an open PR and no live review claim
  integrate = changes with an approved PR and no live integrate claim
  triage    = intake-* stubs without a live triage claim
  decide    = changes with .skein/blocker.md (addressed to the human)
```

`StaleAfter` defaults to three iteration intervals plus the turn ceiling, so
a member deep in a long turn is not declared dead by a faster peer.

### Inbox

Per loop record, in memory like `steers`, plus a durable copy on the session
as a synthetic message so a crash does not lose it:

```
inbox: { at, from: { harness, id, name }, mode, msgID, contextID?, text }[]
```

Drained into the brief at the top of the next iteration, then cleared.

## Routing rule for inbound peer messages

```
deliver(inbound):
  loop = Loop.forSession(sessionID) where status in (running, paused)
  if loop:      Loop.inbox(loop.id, inbound); emit(loop)   # no turn started
  else:         SessionPrompt.prompt(...)                   # as today
```

This removes the foreign-turn collision for members: the loop's own
iteration is the only writer of turns in that session. A paused loop still
collects; the messages appear when it resumes. The routing lives where
delivery already converges (`lifecycle.ts` deliver, `send-peer-message.ts`
local path), one call each.

## Routing a piece of work

Routing also has to respect the relationship. Handing an item to a member in
your own working tree is not delegation, it is two agents in one checkout; if
the work is in your tree, either you do it or you hand over the claim.

```
route(item):
  warm   = members whose provider already serves the model this needs, idle
  cloud  = members not bound to a local host
  free   = reachable hosts with a free slot
  if warm.length  -> message the freshest warm member
  if cloud.length -> message a cloud member
  if free.length  -> spawn a subagent placed on a free host
  otherwise       -> leave it on the board; do not spawn into a queue
```

The last branch is the one that matters most and is easiest to get wrong. An
agent that spawns when nothing is free feels productive and is not: the notes
on background subagents record a 22-file refactor delegated as one subagent
while the parent idled and the rest of the fleet sat unused. "Leave it on the
board" is a real outcome, and the board is what makes it safe — someone picks
it up when capacity frees.

## Cursor with claims

```
pick(member):
  mine = live claim held by member            → continue it (resume gate)
  else first of: decide-for-me? no (human)     
                 review items                 (another member's PR)
                 integrate items
                 abandoned items              (resume: same branch/worktree)
                 unclaimed changes            (resolveQueue order)
                 triage items
  claim atomically (insert; on unique violation, re-pick)
```

A member holds at most one implement/resume claim at a time, and may hold a
review claim alongside it only if its implement claim is waiting on
something. Review before integrate before new work is the charter's
priority and also the cursor's; the brief and the code say the same thing.

## Worktree and branch lifecycle

```
claim implement <slug>:
  info = Worktree.makeWorktreeInfo({ name: slug })   # branch loop/<slug>
  Worktree.setup(info); Worktree.boot(info)
  session works in info.directory
gate ladder completes:
  driver pushes loop/<slug>, opens PR (gh), releases implement claim
  board now shows review <slug>
review claim:
  reviewer persona in a detached worktree at the PR head; verdict LGTM /
  NEEDS_WORK posted as PR review; NEEDS_WORK re-opens implement <slug> as
  an unclaimed item carrying the review text
integrate claim:
  merge when review approved and CI green; on conflict, rebase loop/<slug>
  onto the default branch in the change's worktree, run the test gate,
  push, re-request review if the rebase touched more than the conflict
after merge:
  Worktree.remove; archive the change (existing archive step); release
```

Abandoned worktrees are impossible to lose silently: a stale claim keeps
`branch` and `worktree`, and the board lists it until someone resumes or
the human releases it.

## Brief composition (crew mode)

1. Charter (fixed text, short).
2. Operator guidance and `/nudge` steers (as today).
3. Inbox since last iteration, oldest first, each with sender and mode.
4. Board: my claim; others' live claims (holder, gate, age); abandoned;
   review; integrate; decide (for the human, read-only to members);
   unclaimed (first five); triage.
5. Roster: members and their status, from `peers`.
6. Gate instruction, failure output, change documents (as today).

The board and roster are computed each iteration; nothing in the brief is
cached from a previous one.

## Charter text (draft)

> You are one member of a crew working this repository's openspec backlog.
> You are holding one of a small number of inference hosts; your colleagues
> are holding the others. Work you hand to a colleague who is already warm
> costs the fleet nothing. Work you spawn as a subagent takes a host, and when
> none is free it simply queues, so prefer asking a colleague, and when
> nothing is free leave the item on the board instead of spawning into it.
> Unblock others before starting new work: a review someone is waiting on
> beats a fresh change. Claim before you touch a change; work only in the
> worktree your claim names. Announce a claim, a handoff, and a blocker to
> the crew with a short notify; ask a bounded question with a request and
> keep working while you wait. Never take on work a peer says it was denied.
> If the board is empty, say so and stop this iteration; the loop will check
> again. Do not create changes; propose them as intake and let the human
> clear them.

## Idle behaviour

An empty board completes the iteration with no tool calls. The existing
no-progress guard would count that as a stall, so crew mode treats "board
empty" as a distinct outcome: interval backs off (2 s → 30 s → 2 min, cap 10
min) and resets on any board change or inbox message. Idle members still
heartbeat and still receive messages.

## Failure modes

| failure | what happens |
| --- | --- |
| member process dies mid-change | heartbeat stales; claim shows as abandoned with branch and worktree; any member resumes |
| two members pick the same slug | unique index rejects the second insert; it re-picks |
| PR conflicts with default | integrate item rebases in the change's worktree, runs test gate, pushes |
| review says NEEDS_WORK | implement item reopens with the review attached; original holder preferred if live |
| member asks a question, no reply | request deadline from peer-conversation-reliability yields one timeout message; member continues or quarantines with the question in blocker.md |
| change needs a human decision | quarantined; board shows decide item; crew moves on |
| crew proposes work | intake with `origin: crew`; ineligible until the human clears it |
| runaway chatter | inbox is read once per iteration; notify never expects a reply; a reply is never replied to |
| more members than hosts | the extra members find every host held, take board items that need no local inference, or idle with backoff; they never displace a warm colleague |
| a member's host is reassigned a different model | its next placement score drops; it keeps its claim and continues, since the work is in its worktree, not on the host |
| two processes both spawn onto one free host | reservations are per process, so both may pick it; the host queues them. Members coordinate through claims, not reservations |

## Claude Code members

A Claude session is addressed by pid. A member delegating a review or a task
slice writes the claim with `holderHarness: claude-code`, sends the
`[peer-task]` envelope (or a `request` once modes land) with the real return
address, and releases on reply or deadline. Claude's `notify_when_idle`
gives the delegating member a wake signal without polling. Cloud or remote
Claude sessions are reached through Claude's own channel where it supports
them; nothing here depends on it.

## Open questions

0. Should a member ever hand over its *slot* rather than its work — stopping
   so a colleague with a better-suited model can take the host? Cheaper to
   reason about than it sounds, since a claim already records the worktree and
   gate, but it makes membership churn. Recommendation: not in the first slice.

1. Claims in SQLite versus a `.skein/claims/` directory at the main checkout:
   SQLite is shared and atomic; files are visible to Claude members and to
   `git status`. Recommendation: SQLite, with `/crew` rendering the board.
2. Should review use the existing subagent verify gate (`runAgentGate`) in
   the reviewer's own session, or a fresh child session? Recommendation: the
   member's session, so the verdict is attributable and messageable.
3. Should slot reservations become cross-process (a shared table) so members
   in different processes stop double-booking a free host, or is the claims
   board enough? Reservations are a 120 s TOCTOU guard, not a scheduler, so
   the cheap answer is probably to leave them alone and let the host queue.
4. PR creation needs `gh` and a remote; a local-only fallback (merge to an
   `integration` branch) may be needed for repos without one.
5. How much of the `skein-*` command text survives as persona text once the
   board carries the state those commands used to reconstruct by hand.
