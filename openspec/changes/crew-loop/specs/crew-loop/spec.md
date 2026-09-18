## ADDED Requirements

### Requirement: a crew SHALL be defined by running members, not by configuration

Membership of a crew SHALL be the set of sessions currently running the crew loop in a
project, as reported by the peers roster. There SHALL be no fleet configuration file.

#### Scenario: a session joins
- **WHEN** a session starts `/loop --crew` in a project where other members are running
- **THEN** it appears in the other members' next brief as a member and starts picking from the same board

#### Scenario: a session leaves
- **WHEN** a member's session ends
- **THEN** its live claims become abandoned after the stale interval and the branch and worktree are preserved

### Requirement: work SHALL be claimed before it is worked, and a claim SHALL have one live holder

A member SHALL record a claim for a change before touching it. The store SHALL reject a second
live claim for the same change in the same project. The queue cursor SHALL skip changes with a
live claim.

#### Scenario: two members pick at once
- **WHEN** two members try to claim the same change concurrently
- **THEN** exactly one claim is recorded and the other member picks something else

#### Scenario: a member picks
- **WHEN** a member evaluates the board
- **THEN** changes with a live claim by another member are not offered to it as new work

### Requirement: abandoned work SHALL stay on the board and be resumable

A claim whose heartbeat is older than the stale interval SHALL be shown as abandoned with its
branch, worktree, and last gate. Any member SHALL be able to resume it from that state rather
than starting the change over.

#### Scenario: a member dies mid-change
- **WHEN** a member's process is killed while holding an implement claim
- **THEN** after the stale interval the board lists the change as abandoned with its branch, and another member can continue from the recorded gate in the same worktree

### Requirement: a running loop SHALL receive peer messages through its inbox, not as a competing turn

When a session has a running or paused loop, an inbound peer message SHALL be appended to that
loop's inbox and surfaced in the next iteration brief. It SHALL NOT start a new prompt turn in
that session.

#### Scenario: a message arrives mid-iteration
- **WHEN** a peer message reaches a member whose loop is mid-iteration
- **THEN** the current iteration is not skipped or interrupted, and the message appears at the top of the next brief with sender and mode

#### Scenario: no loop owns the session
- **WHEN** a peer message reaches a session with no running or paused loop
- **THEN** it is delivered as a prompt as before

### Requirement: the brief SHALL present the shared board and the crew charter every iteration

Each crew iteration brief SHALL include the charter, operator steers, the drained inbox, the
derived board (own claim, others' live claims, abandoned, review, integrate, decide, unclaimed,
triage), and the member roster, computed fresh for that iteration.

#### Scenario: another member's PR awaits review
- **WHEN** a change has an open PR with no live review claim
- **THEN** every member's next brief lists it as a review item ahead of unclaimed new work

### Requirement: merge-back SHALL be crew work with a completed ladder and a review

Merging a change's branch SHALL require a completed gate ladder, a review verdict of LGTM from a
member other than the implementer, and green CI where CI exists. Members SHALL NOT commit to or
push the default branch directly.

#### Scenario: an integrate item is claimed
- **WHEN** a member claims an integrate item whose PR is approved and green
- **THEN** the branch is merged, the worktree removed, the change archived, and the claim released as completed

#### Scenario: the PR conflicts
- **WHEN** the PR cannot merge cleanly
- **THEN** the integrating member rebases the change's branch in its worktree, runs the test gate, pushes, and re-requests review if the rebase changed more than the conflict

### Requirement: an empty board SHALL produce a quiet wait, not invented work

When the board offers nothing to a member, the iteration SHALL end without tool calls, SHALL
NOT count toward the stall guard, and the interval SHALL back off until the board or inbox
changes.

#### Scenario: nothing to do
- **WHEN** a member finds no claimable item and an empty inbox
- **THEN** it reports the empty board, the next interval is longer, and it still heartbeats and receives messages

### Requirement: the crew SHALL NOT make its own proposals eligible

A change created by a member SHALL be marked as crew-originated and SHALL NOT be queue-eligible
until a human clears it. Human intake via `/idea` SHALL create an intake stub that appears as a
triage item.

#### Scenario: a member proposes a change
- **WHEN** a member writes a new change directory during its work
- **THEN** the change carries `origin: crew` and no member claims it until the marker is cleared by the human

### Requirement: work SHALL be routed to warm capacity before new capacity is spawned

A member deciding where a piece of work goes SHALL prefer an idle member already holding a host
with the needed model loaded, then a member not bound to a local host, then a subagent placed on
a host with a free slot. When no host has a free slot and no member is available, the work SHALL
be left on the board rather than spawned.

#### Scenario: a colleague is already warm
- **WHEN** a member needs a bounded piece of work done and another member is idle on a host already serving a suitable model
- **THEN** the work is sent to that member as a message rather than spawned as a subagent

#### Scenario: the fleet is fully occupied
- **WHEN** every reachable host has no free slot and no member is idle
- **THEN** the work stays on the board, no subagent is spawned, and the member continues with its own claim

#### Scenario: capacity exists but nobody is warm
- **WHEN** a host has a free slot and no member is holding a suitable model
- **THEN** a subagent is placed on that host

### Requirement: a claim SHALL record the capacity it consumes

A claim SHALL record the provider and model its holder is using, where the holder runs on a local
host, so the board shows which hosts are held and by whom.

#### Scenario: two members on one single-slot host
- **WHEN** two live claims name the same single-slot provider
- **THEN** the board shows that host as held by both, so a member can see the second is queued rather than parallel

### Requirement: the roster SHALL show which session holds which inference host

The peers roster SHALL join sessions to local inference hosts, naming the session working on each
host and its loaded model, and SHALL state when every reachable host is occupied.

#### Scenario: an agent decides whether to spawn
- **WHEN** an agent calls the peers tool while every reachable host is occupied
- **THEN** the result names the session on each host and says that a new subagent would queue rather than add parallelism

### Requirement: the roster SHALL state how each peer relates to the caller

Peers SHALL be grouped by whether they share the caller's working tree, share its repository
through another worktree, or are in a different repository, and each group SHALL state the kind
of coordination that fits it.

#### Scenario: a peer is in the caller's own working tree
- **WHEN** another session is working in the same directory
- **THEN** it is presented as sharing the working tree, with the instruction to divide the work before editing

#### Scenario: a peer is in another worktree of the same repository
- **WHEN** another session's directory differs but resolves to the same git common directory
- **THEN** it is presented as sharing branches and history but not files

#### Scenario: a peer is in a different repository
- **WHEN** another session is in an unrelated repository
- **THEN** it is presented as a coordination partner for interfaces, not as a collision risk

### Requirement: the roster SHALL state what each peer is available for

Each peer SHALL carry an availability derived from its status and whether a process is attending
it, distinguishing a session free to take work, a session mid-turn, a session waiting on a human,
and a session nothing is attending.

#### Scenario: a peer is waiting on a permission prompt
- **WHEN** a peer's status is awaiting-permission or stalled
- **THEN** it is reported as not working but blocked until a human answers, rather than as idle

#### Scenario: a peer is idle with a process attending it
- **WHEN** a peer is idle and a process is attending it
- **THEN** it is reported as free to take something on

### Requirement: a working member SHALL publish what it is working on

A crew member SHALL record its current work item where other sessions can read it across
processes, so a peer can decide whether interrupting is warranted rather than inferring it from
a session title.

#### Scenario: a member is asked about work it is already doing
- **WHEN** a member holds a claim and another member reads the roster
- **THEN** the member's current change and gate are visible, and the reader can tell whether its request overlaps that work
