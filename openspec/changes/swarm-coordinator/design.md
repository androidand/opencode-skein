# Design: swarm coordinator

## D1. Shape

```
tick():                                  # idempotent, bounded, no model calls
  require lease(coordinator)             # DB row {holder, ttl, heartbeat}
  grant = lead.grant(); if none: record `no-lead` decision; pause nudging; return
  view  = roster() ⨝ claims ⨝ changes ⨝ gate evidence
  for cond in rules(view): act(cond)     # act ∈ {message once, write record,
                                         #        decision, spawn/stop agent, start/stop loop}
```

Everything it does is recorded in `coordinator_ledger(key, at, action, outcome)`; a restart
rebuilds from the ledger and the DB.

## D2. Rules (from skein D7, kept)

| condition | signal | action |
| --- | --- | --- |
| `IdleWithReadyWork` | agent idle and attended; board has an unclaimed change in a ready column matching its role | message: claim `<slug>` at gate `<g>` (or start a queue loop for it on an in-server agent) |
| `ClaimHeldNoProgress` | claim held, no evidence delta for the gate's `StallAge` | nudge with gate state and next step |
| `RepliedThenIdle` | claim held, busy→idle, no evidence delta | nudge: continue at gate `<g>` |
| `OrphanedClaim` | heartbeat stale, no live agent | release to board; branch and worktree preserved |
| `BlockedUnanswered` | blocker rung deadline passed | rung L2 request to lead, once (`escalate-before-idle`) |
| `ReviewDue` | done without a review at head SHA | trigger `review-on-done` |

Dedupe `(slug, agent, gate, reason)`; backoff `tick×2^n`; after 3, stop and escalate once.
"Send once" is a tested invariant with a positive control.

## D3. Gates and evidence

Gate list and evidence kinds per proposal. `coordinator/gates.ts` is data, validated at load
(closed schema). `complete` for a change fails closed and returns the missing evidence: a
completion token alone is never sufficient. Optional gates (`deploy`, `live-test`) per project
config. Review evidence is `.skein/review.json`; merge evidence is the merge driver's record.

## D4. Lead and delegation

The lead directs; the coordinator mechanises. A directive "take change X" becomes: claim X
for the target agent, start a queue loop for X on it (verified completion), expect an ack,
send nothing further until the budget says so. Completion arrives as the one notice from
`loop-done-handoff`.

## D5. Tools for the lead

`swarm_status` (board, roster, claims, decisions), `swarm_assign(agent, slug)`,
`swarm_nudge(agent, text)` (one message, deduped), `swarm_stop(agent)`. All read the
server's state; none writes authority. Available to in-server sessions as tools; for a Claude
Code lead through a small MCP shim to the project server's HTTP API (spike 0.3).

## D6. Why in the server, not a separate process

The server already owns sessions, loops, the roster, the inbox and the DB; the coordinator
needs exactly that and nothing else, so a second process would re-create the split state
that hurt before. It stays small and replaceable because its only inputs and outputs are the
DB and the server API.

## D7. Standalone mode

Without a project server (standalone processes), the coordinator runs in whichever instance
holds the lease and reads the roster through the sidecar registry. Degraded: no headless
spawn, no in-process delivery. This is the migration path and keeps `--standalone` useful.
