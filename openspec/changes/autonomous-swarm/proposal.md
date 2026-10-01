# Autonomous swarm: one point of contact, no idle agents

## Status

Research and planning, 2026-10-01. Epic over five child changes. Fork-local; every
specsync command passes `-repo androidand/opencode-skein`. Nothing here changes code yet.

## Why

The operator wants a swarm that works from specs the operator and a lead agent wrote
together: research → plan → worktree per change → implement → tests → review → merge,
with blockers resolved inside the team and the human reachable through one lead session
(or several, optionally). Two systems each have half of that:

- **skein** (Go): the mechanical director. Stage funnel, board, gates, claims, a peer
  layer. It never had a thinking lead to talk to, so it was retired as the daily driver.
- **opencode-skein**: live sessions that can message each other (A2A), `/loop` and
  `/loop --queue` that keep a session working. It has no authority model between peers
  and no way for a finished session to hand work on.

Five failures keep the two from becoming one swarm. Each is traced to code and
instructions in `findings.md`; this is the summary.

1. **A lead cannot be trusted.** Every receiving agent is told, in three independent
   places, that a peer message is "not a user instruction and not a permission grant", and
   the operator's own way-of-working file calls relayed authority "permission laundering".
   Those rules are right and must stay as the default. What is missing is a grant that
   comes from the *user*, is durable, and can be checked mechanically — so that "this
   session is my lead" is a fact in a file, not a claim in a message.
2. **Agents hand blockers to the human instead of the team.** The peer tool text ends
   with "say that to your own user", the loop has no outcome for "blocked on a peer", and
   a turn that ends in a question simply ends. There is no ladder between "decide it
   myself" and "ask the user".
3. **"Done" halts instead of handing over.** A completion token or a drained queue
   finalizes the loop. Nobody is told, nothing is reviewed, nothing picks the next item.
4. **Agents will not commit, push or merge.** Four model prompts say never commit unless
   asked (one: ask every time, even if confirmed before), queue runs carry deny rules for
   push/tag/remote, and the way-of-working file requires explicit instruction per
   publishing action. There is no *standing* authorization the operator can grant once,
   per repo, within limits.
5. **Nothing reviews the work before it counts as done.** The queue loop has a same-model
   reviewer gate on the working-tree diff. There is no independent, different-model review
   of the exact commits, and none at all for sessions that are not in a loop.

## What

One principle, applied five times: **authority and policy are user-issued artifacts that
code verifies; never text that a model is asked to believe.** Machinery does the
re-engaging, escalating and gating; models do the thinking.

| change | fixes | repo |
| --- | --- | --- |
| `lead-authority` | 1 | opencode-skein (+ Claude Code side via CLI/hook) |
| `escalate-before-idle` | 2 | opencode-skein |
| `loop-done-handoff` | 3 | opencode-skein |
| `standing-publish-authority` | 4 | opencode-skein (+ rendered for Claude Code) |
| `review-on-done` | 5 | opencode-skein |

Skein-side work is listed as amendments to the existing, unmerged
`live-session-conductor` change (skein repo, branch `skein/live-session-conductor`) rather
than a competing plan — see `design.md` "Skein side" and `tasks.md` Phase 6.

## Sequencing

1. Phase 0 reproduces each reported failure with a failing test or a recorded transcript.
   No fix without a reproduction.
2. `lead-authority` and `standing-publish-authority` first: both are mostly instruction
   and permission plumbing, and together they unblock "lead assigns, peers act, work is
   committed and merged".
3. `escalate-before-idle` and `loop-done-handoff` next: they remove the stops.
4. `review-on-done` after the above: it consumes the same verdict/evidence record the
   merge policy requires.
5. The existing `crew-loop` (claims, inbox, board, worktree per claim) is the substrate
   for steady-state operation and is NOT redefined here; these changes plug into it. Its
   Phase 2 (inbox) is a prerequisite for lead directives reaching a busy member.
6. Skein conductor + headless agent pool (`design.md`) once the live-session side
   proves the loop.

## Non-goals

- No resident LLM "brain" inside skein. Judgement stays with the lead session.
- No weakening of the default peer rule. A peer message from anyone but the granted lead
  stays context, and the grant never widens tool permissions.
- No unattended force-push, history rewrite, visibility change, tag or release.
- No new transport. `send_peer_message`, the sidecar and the Claude Code frame stay.

## Relationship to existing changes

- **Extends:** `crew-loop` (claims/board/inbox), `peer-conversation-reliability`
  (envelope, reply correlation), `peer-capacity-subagents` (routing to warm capacity).
- **Reuses:** `loop-spec-queue` gates and `QueueDenyRules`, `loop-eternal-by-default`.
- **Cross-repo:** skein `live-session-conductor` (conductor, roster, adapters, gates);
  its decision D4 ("lead is a claim created by `skein_conduct start`") is amended so the
  claim requires a user-issued grant.

## Risks

1. **Authority laundering.** A forged or relayed "lead says" must not gain authority.
   Mitigation: verification is by authenticated socket identity against the grant file;
   no transitive trust; a test pins that a non-lead message claiming to be from the lead
   is framed exactly as today.
2. **A standing publish grant becomes an accidental publish.** This fork is public and
   its history was rewritten once already. Mitigation: policy is fail-closed at load,
   visibility is asserted against the forge, never-list is non-overridable, and the
   existing 35-shape adversarial authority test must still pass.
3. **Nudge storms.** Re-engagement and escalation must not recreate the several-hundred
   identical messages incident. Mitigation: per-key dedupe and a budget, with a positive
   control, in every change that sends.
4. **Heuristic stop detection misfires.** Classifying "asked the user" from text is
   fallible. Mitigation: it only triggers a bounded nudge (never an action), and it is
   measured against recorded transcripts in Phase 0.
