# Skein pool: one placement layer for local hosts and live agents

## Why

Three planned changes describe the same machine from three angles and none of them has
moved since July:

- `provider-slot-leases` (0/15) — stop concurrent opencode instances double-booking a
  single-slot host.
- `fleet-instance-presence` (5/23) — see running instances/sessions, their status, and
  delegate to them.
- `peer-messaging` (7/9) — send a message to another live session.

Since then `claude-code-peer-source` and `claude-peer-messaging` shipped A2A: every
opencode and Claude Code session on the machine is discoverable (`peers`,
`opencode agents --json`) and messageable (`send_peer_message`), from any directory. That
already delivers `peer-messaging` entirely and the roster half of
`fleet-instance-presence`. What is left of all three is one question, asked from the
sub-agent flow:

> Which local hosts and which live agents can take work for me right now, and how do I
> hand it off without two of us landing on the same GPU slot?

Today `task.ts` answers only half of it. `LocalPlacement.pick` places a sub-agent on an
idle llama-skein host (slot-aware, context-aware, role-aware — `ctx-aware-subagent-placement`,
`role-placement-policy`, `provider-capacity-truth` all shipped), but:

1. Its slot reservations live in one process. Four opencode processes on one machine each
   see gpuhost2 as `in_flight: 0, slots_total: 1` and all four dispatch (2026-07-25).
2. It never considers the *other* pool: a live, idle opencode or Claude Code session that
   already has a model, a context and a warm cache. When the local GPU cannot host another
   session, the parent inherits its own cloud model and pays twice, while an idle peer sits
   there.
3. Nothing shows held capacity. `peers` shows who is idle; nothing shows that host X's
   single slot is already promised to someone.

### What is already true about multi-slot context (checked 2026-09-18)

The "parallel slots split the context → endless compaction loop" concern is handled at the
source and does not need a new opencode mechanism:

- llama-skein `internal/fit/fit.go:505-512` divides `max_safe_ctx` by `--parallel` — the
  figure it advertises is the per-request share.
- llama-skein's `promptguard` pre-flight rejects any prompt over that share with a 413
  (`prompt_over_max_safe_ctx`) carrying the ceiling in a header.
- opencode adopts `max_safe_ctx` as `limit.context` on discovery
  (`provider.ts:1698-1720`) and re-adopts the header value on that 413
  (`adjustLocalContextOnOverflow`).

The 483 "compaction overflow" log lines all belong to one session on 2026-07-16, before
this chain existed. The residual gap is **staleness**: opencode learns the per-slot ctx at
discovery and on 413, but not when a host's `--parallel` is changed while a session is
running. Placement below re-probes `/api/fit` per pick anyway; the fix is to let that fresh
`max_safe_ctx` update the live `limit.context` too (task 1.3), not a new subsystem.

## What Changes

### 1. Two pools, one `pick`

`LocalPlacement.pick` gains a second candidate kind next to `host`:

```
host  { providerID, modelID }                  — spawn a new sub-agent session on a llama-skein host
peer  { owner, instanceID, sessionID, name }   — delegate the task to a live idle agent over A2A
```

A `peer` candidate is any roster entry (`session/peers.ts` + `presence-claude.ts`) that is
`idle`, not the caller, and — for opencode peers — reports `canPrompt`. Its "model" is the
model it is already running; its "context" is that model's `limit.context` minus its
current usage; it needs no slot because it already holds one. Eligibility is the same
gate hosts pass: enough context for the estimated prompt, allowed by the role's
`placement`.

Scoring keeps the existing terms and adds one tier: a role may say `prefer: "peers"` /
`"hosts"` / a mixed ordered list, using the `hostRankFor` mechanism that already exists.
Default: hosts first (a fresh session is a cleaner sandbox), peers when no host has a free
slot. Nothing changes for a single instance with no peers.

### 2. Delegation over A2A

Delegating to a `peer` reuses `send_peer_message`'s transport (opencode → synthetic prompt,
Claude Code → UDS envelope) with a structured `task` envelope: task id, instructions,
reply-to (the parent's own peer address), deadline. The peer runs it as a normal prompt in
its own session and replies with `send_peer_message` back to the parent, which lands as
the sub-agent result the way a `task` tool result does today. If no reply arrives by the
deadline the parent re-places or inherits — the same fallback `pick` already has.

This is the "existing agent reuse" that `fleet-instance-presence` 4.7 described, with
A2A as the handoff instead of a Supervisor API that was never built.

### 3. Leases where the slot lives

`provider-slot-leases` proposed a three-tier lease store (SQLite / skein claims / memory).
The evidence says put it in one place: the host. llama-skein already owns `slots_total`
and `in_flight` and every opencode instance on every machine already asks it before
placing. Add to llama-skein:

```
POST   /api/slots/lease   { holder, ttl_s }  → { lease_id, expires_at }   409 when none free
DELETE /api/slots/lease/{id}
GET    /api/hardware      inference: { slots_total, in_flight, leased, holders[] }
```

A lease counts against free slots exactly like an in-flight request, expires on its own,
and is released when the sub-agent finishes (the `release` handle `task.ts` already holds).
opencode's in-process reservation stays as the sub-millisecond TOCTOU guard within one
process; the lease is the cross-process, cross-host truth. Hosts running an older
llama-skein without the endpoint fall back to today's behaviour — the pool must not depend
on it.

### 4. Roster shows capacity

`peers` / `opencode agents --json` grow a capacity block per host, alongside the agents:

```
● gpuhost2        host   qwen3.8-27b   slots 1/1 leased by opencode:A2A feature (0:42 left)
● gpuhost1     host   ornith-35b    slots 0/1 in flight
○ example-corp-5e claude              idle · can take work
```

so "who can I hand this to" is answerable by a human and by the model from the same view.

## Supersedes

- `provider-slot-leases` — leases move to llama-skein (§3); the tiered store is dropped.
- `peer-messaging` — shipped as `claude-peer-messaging`'s `send_peer_message`; the two
  unchecked tasks (3.1, 3.2) are covered by §2's deadline/unreachable handling.
- `fleet-instance-presence` — Phases 1–2 shipped (roster); Phase 3 (stall detection) and
  4.1–4.3 (remote cancel) move to their own small change if still wanted; 4.5–4.7 are §1–2
  here.

`ctx-aware-subagent-placement` task 5 (wall-clock ceiling on a queued local sub-agent)
becomes this change's task 2.4 — the deadline is the same mechanism for hosts and peers.

## Non-Goals

- No Supervisor process, no consensus, no distributed lock manager.
- No cross-host *agent* discovery beyond what A2A does on one machine; cross-host capacity
  comes from llama-skein hosts, which are already reachable.
- Not changing how a Claude Code peer runs the task — it receives a prompt, nothing more.

## Impact

- `packages/opencode/src/local/placement.ts` — `peer` candidate kind, lease acquisition.
- `packages/opencode/src/tool/task.ts` — delegate path, reply correlation, deadline.
- `packages/opencode/src/tool/peers.ts`, `cli/cmd/agents.ts` — capacity block.
- `packages/opencode/src/peer/` — task envelope (shared with Claude Code codec).
- llama-skein — lease endpoint and `leased`/`holders` in `/api/hardware`; regenerate the
  opencode client (`bun run build:llama-skein-client`).
- `fork/manifest.json` — register every touched upstream file.
