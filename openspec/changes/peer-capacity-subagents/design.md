# Design notes: borrowing peer capacity

## The two shapes, and why one gets used

| | subagent (`task`) | peer message |
| --- | --- | --- |
| model's view | a call that returns | a letter that may be answered |
| turn | continues | ends |
| failure | an error it can act on | silence |
| natural use | constant | rare, and only when told |

Nothing here is a deficiency in the models. A tool that suspends the plan on
the chance of a later reply is genuinely harder to use than one that returns.
The design consequence: **work handoff goes behind `task`; messaging stays for
coordination**, which is the thing it is actually good at.

## Host, not worker

```
A: task(...)  ──placement──▶  peer B chosen as HOST
                                  │
                                  ├── B creates child session C (empty history)
                                  │     provider/model = B's
                                  ├── C runs the task under B's permissions
                                  └── result ──▶ A, correlated by header
B's own session: one line, "hosted task <id> for <session>"
```

C is discarded when the task ends. B never reads the task text as a prompt.
That is the whole difference from today's `[peer-task]` envelope, which is
injected into B's own session and therefore does exactly what the user was
worried about.

## Ranking

```
score(candidate):
  unowned host, model resident        best
  unowned host, model needs a load
  owned host, bound session serves the same model
  cloud-backed peer                   (costs the local fleet nothing)
  owned host, bound session serves a different model   worst — forces a swap
  unknown (probe failed)              below anything visible, above nothing
```

"Unowned" means no live session's `provider` matches this host. That is an
inference, not a record — a session's provider says what it is configured for,
not that it is mid-request — so the host's own in-flight count remains the
authority for whether a slot is free. The ownership signal only breaks ties.

## Refusal

A host may decline: it is about to need its slot, it is in a permission mode
that forbids it, its user said no. Refusal returns immediately and placement
picks the next candidate. Being idle is not consent, and a host that cannot
refuse would make lending unsafe to enable by default.

## What this does not solve

Cross-process slot reservations are still per process and in memory, so two
opencode processes can still both pick the same free host and queue behind each
other. That is `skein-pool`'s problem, not this one, and it is survivable —
the host serialises them.

## Open questions

1. Does hosting need a config switch per machine (`experimental.host_peer_subagents`)
   defaulting on, or is refusal enough?
2. Should a hosted child appear in the host's session list at all? Visible is
   honest but clutters; hidden is clean but makes a runaway hard to find.
   Leaning visible, marked as hosted.
3. Should the caller see which host ran it? Useful for debugging, and it leaks
   nothing a peer roster does not already show.
