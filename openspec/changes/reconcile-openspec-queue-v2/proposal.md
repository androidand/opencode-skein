# Reconcile the OpenSpec queue for the opencode-to-plugin route (P1.9)

Parent: Phase 1a item P1.9. Gates any further work executed **inside opencode-skein**
(the ports live in the plugin repo and do not block on this).

## Why

The active queue sits in shadows: several changes describe behavior against the dead
fork layout (`crew-loop`, `model-gallery-ui`, `per-model-placement-controls` — audit-
named), several landed with the PR already merged (`sidecar-orphan-cleanup`), and the
v2 pivot changes the runtime each of them assumes. Implementing against an
unreconciled queue means writing behavior into a tree scheduled for deletion — the
exact failure the evaluation's risks section warns about. This change is
bookkeeping-with-verdicts: each active change gets a classification and the file
edits that make the truth agree with the plan.

## What Changes

For every active change in the queue, one classification:
- **continue** — proceeds as specified;
- **amend** — proposal gets a revision note (runtime assumption changed; scope kept);
- **supersede** — requirements carried into a named port change (both sides cite
  each other);
- **archive** — done (evidence linked) or obsolete (reason recorded).

Classification below (current basis: this worktree's tree, 2026-10-25):

| Change | Verdict | Note |
|---|---|---|
| acp-external-verification | amend (done here) | re-anchored to upstream ACP; no longer completes the fork migration |
| ahp-host | amend (done here) | implementation blocked on the upstream desktop/UI evaluation |
| auto-across-repos | continue | ready-work contract (R5) is its unlock |
| autonomous-swarm | continue | epic; consumes the port changes' outputs |
| confirm-sender | continue | small peer-flow fix, carried through `port-peer-plugin`'s tests |
| crew-loop | supersede | carried into `port-loop-crew-plugin` (shared-file claims landed; runtime moves) |
| escalate-before-idle | continue | behavior-level; not layout-bound |
| fix-queue-branch-awareness | continue | merge its task list into the loop port's queue tasks |
| fleet-live-verification | continue | soak-phase adjacent |
| lead-authority | continue | policy core; grant-verification model unchanged |
| long-session-memory-retention | amend | re-anchor against upstream v2's context behavior (fork `context/` is slated for deletion) |
| loop-done-handoff | supersede | carried into `port-loop-crew-plugin` (handoff requirement) |
| loop-unattended-permission-asks | amend | re-anchor on what `opencode service` does for prompts (P1.7 verification decides) |
| mission-control | continue | unaffected by the runtime swap |
| model-gallery-ui | supersede | carried into `port-local-plugins` (gallery as plugin route) |
| models-picker-ux | amend | verify against v2's model surface before implementing |
| peer-capacity-subagents | continue | ties to `skein-pool`; runtime-independent |
| peer-conversation-reliability | continue | implemented by `port-peer-plugin` |
| per-model-placement-controls | supersede | carried into `port-local-plugins` (§11.4 regressions) |
| project-server | amend (done here) | verify-first against `opencode service`; the §7.4 record stays |
| review-on-done | continue |
| sidecar-orphan-cleanup | archive | landed (PR #113); evidence in the merge |
| skein-control-plane | continue | strengthened by the pivot (server API / ACP, never fork internals) |
| skein-observability | continue |
| skein-pool | continue | llama-skein lease extension (R4) is its open dependency |
| skein-soak-hardening | continue | composes everything |
| standing-publish-authority | continue |
| swarm-coordinator | continue | stays project-local per `06-work-breakdown.md` §4 |

(The table is the classification of record; file edits land with this change and each
verdict edit cites this table's ID.)

## Non-goals

No new capability specs here except the queue's own hygiene requirements. No
runtime/code behavior changes land under this change itself.

## Risks

- Classification drift: v2's behaviors (e.g. `opencode service` prompts) are still
  unverified for some rows — rows keyed on pending verifications carry the dependency
  instead of guessing.

## Impact

Queue fully classified; the port changes can read the queue as truth. specsync
`link` cross-references for supersede pairs puts the same truth on the tracker.
