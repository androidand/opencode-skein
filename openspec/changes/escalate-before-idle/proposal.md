# Escalate before idle: a ladder between "decide myself" and "ask the human"

Parent: `autonomous-swarm` (F2).

## Why

Agents stop and hand to the operator with sentences like "Peer X owns blocker Y, so I
cannot continue until that is solved". The operator then talks to every session by hand.
Causes found in code:

- `send-peer-message.txt` ends: "If you cannot continue without an answer, say that to your
  own user rather than asking the peer again." With "send once", "never ask whether a peer
  is done" and "do not reply to a reply", the safe reading is: one message, then stop and
  tell the human. Those rules exist for a real storm (hundreds of identical messages,
  2026-09-18) and over-corrected.
- The loop recognises empty output, plan-without-tools and repetition
  (`loop/continuation.ts`). It has no concept of a turn that ended asking a question or
  waiting on a peer, so such a turn ends the run or burns the no-progress budget.
- `.skein/blocker.md` quarantines a stuck change while the queue continues, but nothing
  tells a model to use it for "waiting on a peer", and nothing re-checks it when the peer
  answers.

## What Changes

1. **The ladder** (design D3 of the epic), stated in the brief charter and the tool text:
   decide from specs → ask the owner peer once with a deadline and continue other work →
   ask the lead once after the deadline → record a blocker tagged `needs: team|human` and
   move on → only `needs: human` reaches the human, as a board item.
2. **Blocker records get structure**: `.skein/blocker.md` gains front matter
   (`needs`, `waiting-on`, `asked-at`, `deadline`, `rung`), parsed with a closed schema, so
   the driver can enforce rung order and wake the item when the peer replies.
3. **Wake, don't poll**: when a member is blocked on a peer it registers a wake on that
   peer's reply or idle (the existing `PeerInbox` drain-on-idle and reply correlation),
   plus a durable deadline timer in the loop. No "are you done?" messages.
4. **Stop classifier** in the loop: a turn that ends with no tool calls and text matching
   "asking the user / waiting on a peer / cannot continue until" is classified
   `blocked-on-human-or-peer` and answered with a bounded ladder nudge ("do not stop to ask:
   apply rung N") instead of ending the run. Pure, import-free module like
   `loop/continuation.ts`. It only ever produces a nudge, never an action.
5. **Tool text and charter corrected** so "say that to your user" is the last rung, not the
   first, while keeping every anti-storm rule: one message per `(item, rung)`, repeat guard
   intact.
6. **Plain (non-loop) sessions** get the same ladder through the instruction fragment, and
   the lead frame from `lead-authority` already says "reply to the lead; do not ask your
   user first".

Wake sources and the deadline timer are simplest inside a project server (one in-process
inbox, durable loop records) and degrade to the per-process versions otherwise.

## Non-goals

- No automatic answer on the human's behalf for `needs: human` items (goal ambiguity,
  credentials, irreversible or never-listed actions).
- No new message transport; no polling.

## Impact

`loop/continuation.ts` (+ new `loop/stop-reason.ts`), `loop/loop.ts` iteration handling,
`loop/spec-queue/*` (blocker schema, wake), `tool/send-peer-message.txt`,
`session/peers.ts` charter text, `peer/inbox.ts` wake hook, tests.
