# Swarm coordinator: skein's conductor ideas, inside the project server

Parent: `autonomous-swarm`. Depends on `project-server` (hosts it) and `lead-authority`
(who may direct). Replaces the plan to depend on the Go skein for any of this.

## Why

The Go skein's useful ideas are mechanical, not LLM: a stage/gate graph with evidence, stall
rules, send-once nudges with backoff, claim reaping, a roster, a spawn path, a board. Its
failure was a resident process that owned its own agency and its own state. With a project
server that already owns every agent session, the same ideas fit as a module that reads
server state and the database and does five things only: send one message, write one
record, raise one pending decision, spawn or stop an agent, start or stop a loop. It never
runs a model turn of its own, and every judgement call goes to the lead.

## What Changes (ideas absorbed from skein, by source)

| from skein | becomes |
| --- | --- |
| `pipeline_stages.go` stage graph | `coordinator/gates.ts`: worktree → implement → tests → review → merge → push → [deploy] → [live-test], each with named evidence (checked tasks, gate run outcome, PR/commit, `.skein/review.json` verdict, merge SHA). Reuses `loop/spec-queue/gates.ts`. |
| stall rules / watchdog thresholds | `coordinator/rules.ts`: `IdleWithReadyWork`, `ClaimHeldNoProgress`, `RepliedThenIdle`, `OrphanedClaim`, evaluated from the roster and claims only |
| nudge protocol | `coordinator/nudge.ts`: dedupe key `(slug, agent, gate, reason)`, backoff `tick×2^n`, budget 3 then escalate to the lead once; ledger in the DB |
| claims / board | `crew-loop` claims table and board, unchanged; the coordinator reaps and reassigns |
| roster + adapters | in-server `Roster` (from `project-server`) plus foreign adapters for Claude Code over the sidecar; one `AgentAdapter` interface (`prompt`, `steer`, `interrupt`, `capabilities`) |
| runner / spawn | `agent spawn` (from `project-server`) |
| `skein_conduct` MCP | the coordinator's tools, available to the lead session: `swarm_status`, `swarm_assign`, `swarm_nudge`, `swarm_stop`; for a Claude Code lead, a thin MCP shim that proxies to the project server (spike) |
| pending decisions | board `decide` items, rendered from `.skein/blocker.md` (`escalate-before-idle`) |
| provider chains / model choice | existing placement + persona models; no new config |
| fleet YAML | optional spawn templates only (role, model, change filter); presence comes from discovery |

The coordinator is a plain tick (default 30 s) that is idempotent and writes only through
the ledger, so it can run in whichever server instance holds the coordinator lease (database
row with TTL and heartbeat) and move on failure. With a shared project server there is
normally exactly one holder.

## Trust and authority

The coordinator acts for the lead. It holds no authority of its own: the `lead-authority`
grant names it as a delegate with scope `nudge` (and `spawn` if the operator adds it).
Messages it sends carry the lead frame because the server attributes the sender, not because
the text says so. It cannot widen permissions or publish; `standing-publish-authority`'s
merge driver is a separate, policy-gated action it may *request* but not perform.

## Non-goals

- No LLM in the coordinator; no scope, plan or priority decisions.
- No replacement for the lead: "what to build next" is the lead's, from specs.
- No dependency on the Go skein. Interop with skein over A2A may remain, optional.

## Risks

1. **Rebuilding the resident-process failure.** Mitigation: all coordinator state in the DB;
   lease-based; restart replays; negative-control soak asserts an idle coordinator writes
   nothing.
2. **Nudge storms.** Mitigation: dedupe key, budget, positive-control test.
3. **Coordinator misreads a healthy long turn as stalled.** Mitigation: per-gate `StallAge`
   thresholds and the roster's busy signal (exact, not windowed) gate every rule.

## Impact

New `coordinator/*` (gates, rules, nudge, lease, tools), `crew-loop` board hooks,
`session/peers.ts` roster consumers, tool registry, TUI view, tests.
