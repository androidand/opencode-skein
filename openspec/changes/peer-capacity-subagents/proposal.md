# Borrow a peer's capacity as a subagent, not as a conversation

## Why

A2A works and agents do not reach for it. Subagents they reach for constantly.
That is not a training gap, it is the shape of the two tools.

A subagent is a **function call**: describe the work, get a result, the turn
continues. A peer message is a **letter**: send it, the turn ends, something
may arrive later. One composes with how a model thinks about a task; the other
asks it to suspend a plan on the chance of a reply. Given both, a model picks
the call every time, and it is right to.

So the fix is not to make agents like messaging. It is to put peer capacity
behind the tool they already use.

Some of this exists. `tool/task.ts` places a subagent on an idle local host,
and falls back to `peer/delegate.ts` when every host is full. In practice it
is rarely seen, for three reasons worth separating:

1. **The trigger is too narrow.** Peer delegation fires only when
   `parentCapacity` is exactly `"no-slot"`. A probe that fails returns
   `"unknown"` and inherits instead. Placement is skipped entirely when the
   agent pins a model or the session is resumed.
2. **The roster was broken until 2026-09-19.** Candidates come from
   `resolveMessageTargets`, which was project-scoped and hid idle sessions.
   On a machine with peers in several repos it frequently returned nobody, so
   delegation had nothing to choose from and silently inherited.
3. **A free slot is not the same as an available host.** `freeSlots` compares
   in-flight against slots_total. A host can show a free slot while a live
   session sits on it between turns. Taking that slot competes with the next
   turn and can force a model swap that destroys the session's warm cache —
   which placement scores as the single most expensive thing it can do.

## What changes

### 1. A peer lends capacity, it does not lend its conversation

The objection to "ask an idle peer to be my subagent" is that the peer's
transcript fills with someone else's work. That is a real cost: context, money,
and a genuine risk of the peer confusing borrowed work with its own.

It dissolves once lending capacity is separated from doing the work. A peer
asked to host a subagent **creates a fresh child session** and runs the task
there. The child inherits the peer's provider and model — which is the capacity
the caller wanted — and nothing else. The peer's own session gets one line
saying it hosted a task, not the task.

This also fixes something the current `[peer-task]` path gets wrong: today the
envelope is injected into the peer's own session as a prompt, so borrowed work
really does land in its history.

### 2. Availability means unowned, not merely unoccupied

A host is a good subagent target when it has a free slot **and** either no live
session is bound to it, or the session bound to it already serves the model the
task needs. `Peer.provider`/`Peer.model` joined against
`LocalPlacement.hostCapacity` already answers this — `describeFleet` does the
join for display; placement should use the same signal to rank.

Ranking, best first: an unowned host with the model resident; an unowned host
needing a load; a host whose bound session already serves that model; a
cloud-backed peer, which costs the local fleet nothing. A host whose bound
session serves a *different* model is last, because taking it forces a swap.

### 3. Widen the trigger, and say when it does not fire

Peer capacity is considered whenever placement runs and the local pick is worse
than a peer — not only at `"no-slot"`. A failed probe stops meaning "inherit
silently": it means unknown, and unknown ranks below a peer we can actually
see. Every decision logs which option was chosen and why, so "I never see it
used" becomes answerable from the log instead of from a guess.

### 4. Borrowed work is bounded and attributable

A hosted subagent carries the requesting session's identity, a deadline, and
the caller's task description. The host applies its own permission rules, never
the caller's. A host may refuse — being idle is not consent — and a refusal is
a normal answer, not an error. The result returns through the existing
correlation header, and a request that misses its deadline is reported to the
caller rather than left hanging.

## Non-goals

- Not a scheduler or a work queue. This is one decision at one call site.
- Not cross-machine. Same-machine peers only, as discovery already is.
- Not a replacement for `send_peer_message`. Coordination between agents stays
  messaging; only *work handoff* moves behind `task`.
- No change to permission boundaries. A borrowed subagent runs under the host's
  rules, and a caller cannot gain reach by delegating.

## Dependencies

- `peer-conversation-reliability` for the correlation header, the real return
  address and honest delivery states.
- The roster fixes of 2026-09-19, without which candidate lists are empty.
- `skein-pool` overlaps deliberately: it asks "which hosts and agents can take
  work", this answers "and how is that handed over without polluting a peer".
  If both proceed, this is the handoff half.
