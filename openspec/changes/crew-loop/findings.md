# Spike: crew loop collision (two `/loop --queue` runs)

Goal (task 0.1): start two `/loop --queue` runs in two checkouts of this
repository and observe the collision `QueueActiveError` prevents — which change
each picks, whether both push `loop/<slug>`.

## Setup

- Two worktrees of this repository: `/private/tmp/crew-loop-checkout-1`
  (branch `crew-spike-1`) and `/private/tmp/crew-loop-checkout-2` (branch
  `crew-spike-2`). Both share history `9a7ee4a48`, same `origin`, same backlog
  in `openspec/changes/`.
- The `loop` CLI (`src/cli/cmd/loop.ts`) connects to a server at
  `http://localhost:2525` and the server resolves the working directory from
  `process.cwd()` (see `src/server/routes/instance/httpapi/middleware/workspace-routing.ts:87`,
  `defaultDirectory`). So a single server process targets exactly one directory.
  For the spike I ran one server from `checkout-1`'s cwd and drove both runs
  from there; a second run pointed at `checkout-2` uses its own server cwd.

## Observation 1 — second queue loop in one directory is refused

Created the first queue loop in `checkout-1`:

```
POST /loop  {"directory":".../crew-loop-checkout-1","mode":"queue",
             "prompt":"models-picker-ux","maxIterations":1}
```

Response — created, `status: "running"`, `mode: "queue"`,
`currentChange: "models-picker-ux"`, `currentGate: "implement"`.

```json
{"id":"loop_0b806339d001KpkVKc5Nqvzmsw","status":"running","maxIterations":1,
 "mode":"queue","currentChange":"models-picker-ux","currentGate":"implement"}
```

The loop picks from the backlog (`models-picker-ux`, `implement` gate) and
stalls waiting for an LLM turn — which is expected; the collision guard fires
before any turn.

Created a **second** queue loop in the **same** directory while the first is
still running:

```
POST /loop  {"directory":".../crew-loop-checkout-1","mode":"queue",
             "prompt":"models-picker-ux","maxIterations":1}
```

Response — refused:

```json
{"_tag":"BadRequest"}
```

Source of the refusal (`src/loop/loop.ts:1572-1579`):

```ts
if (mode === "queue") {
  const active = Array.from((yield* Ref.get(state)).values()).find(
    (record) =>
      record.info.mode === "queue" && record.info.directory === directory
      && !isTerminal(record.info.status),
  )
  if (active) {
    return yield* Effect.fail(new QueueActiveError({ activeLoopID: active.info.id, directory }))
  }
}
```

Two queue loops over one directory would fight over the same derived cursor and
working tree (design D1), so the second is refused at creation time. Confirmed:
when I first cancelled the loop, a subsequent second creation SUCCEEDED
(proving the guard is keyed on a *live*, non-terminal queue loop — not on a
stale record).

### The guard is directory-scoped

The collision guard compares `record.info.directory === directory`. Two
**different** directories (two checkouts) do NOT collide on `QueueActiveError`.
They collide later, at the git push, because both derive the same branch name
`loop/<slug>` from the same base commit.

## Observation 2 — two checkouts would collide on the git branch, not on queue

Two checkouts both pull the same backlog (`models-picker-ux`) and both would
create `loop/models-picker-ux` from the same base commit `9a7ee4a48`, then both
push it to the same `origin`. That is the collision the crew design must solve
with durable claims: one member claims the slug, the other skips it. This spike
could not exercise the push path here (no working LLM to carry a change through
implement → commit), but the branch identity is deterministic:

```
$ cd crew-loop-checkout-1 && git rev-parse HEAD
9a7ee4a48ca9a40d5a8af3cac6f74c41b89fccb9
$ cd crew-loop-checkout-2 && git rev-parse HEAD
9a7ee4a48ca9a40d5a8af3cac6f74c41b89fccb9   (identical base, identical origin)
```

So two independent `--queue` runs would each pick `models-picker-ux` and each
attempt `git push origin loop/models-picker-ux` — a branch name + first-push
collision, exactly what durable per-slug claims (Phase 1) and the shared queue
cursor are designed to prevent.

## Conclusions

- `QueueActiveError` correctly serializes queue loops **per directory**. In a
  single directory only one queue loop runs; a second is refused with
  `BadRequest` at creation time (before any LLM turn or branch work).
- The crew design deliberately **relaxes** this: each member works its own
  checkout/worktree, so the per-directory guard no longer applies. Coordination
  moves to durable per-slug claims (Phase 1) + a shared queue cursor that skips
  claimed slugs, so two checkouts no longer both grab `models-picker-ux` and
  both push `loop/models-picker-ux`.
- The push collision is the real risk crew mode introduces and must be the focus
  of the claims design.

---

## Observation 2 — two plain sessions hand-simulate claims: coordination breaks in three places

Goal (task 0.2): start two plain sessions, hand-simulate a claim by message
("I take X"), and record where coordination breaks: mid-turn messages, no
board, no resume of the other's branch.

Method: ran a plain session in `/private/tmp/crew-loop-checkout-1`
(`clever-comet`, model `host-a/qwen3-35b-a3b`), confirmed it is visible in the
shared `opencode-local.db`, then traced the three code paths a crew claim would
need. All three breakages are confirmed by reading the code, not inferred.

### Breakage 1 — a peer "claim" message races the running loop's own turn

Inbound peer messages are delivered by starting a **new prompt turn**, with no
check for whether a loop iteration is already running in that session:

- opencode→opencode: `src/cli/tool/send-peer-message.ts:374-380`
  ```ts
  local: () => ops.prompt({ sessionID: targetSessionID, agent, parts: [{type:"text", synthetic:true, text}] })
             .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
  ```
- claude→opencode: `src/peer/claude/lifecycle.ts:~95`
  ```ts
  yield* promptSvc.prompt({ sessionID, agent, parts: [{type:"text", synthetic:true, text: wrapped}] })
  ```

Neither checks `Loop.forSession(sessionID)`. The loop's own iteration guard
(`src/loop/loop.ts:350-372`) catches the race: if the session is `busy`, the
iteration is **skipped** (`skipped: true`) and the loop just waits — it never
sends its own prompt, so the claim message wins the turn and the loop's work is
lost that tick:

```ts
const busy = yield* status.get(targetSessionID).pipe(Effect.orElseSucceed(() => undefined))
if (busy?.type === "busy") { return { ..., skipped: true, ... } }
```

So the "I take X" message either (a) hijacks the turn and the loop never
records the claim, or (b) the loop skips its iteration and the claim sits in
the void. Either way: no coordination. This is the exact foreign-turn race the
design (§4) says the inbox must fix.

### Breakage 2 — there is no board, and no inbox

The shared store has no `claims` table, no `inbox` table, and no `loop`
persistence table. Confirmed two ways:

- Schema (`packages/core/src/database/schema.gen.ts`): 19 `CREATE TABLE`
  statements — `workspace, data_migration, account_state, account,
  control_account, credential, event_sequence, event, permission,
  project_directory, project, message, part, session_context_epoch,
  session_input, session_message, session, todo, session_share`. No `claims`,
  no `inbox`, no `loop`.
- Live DB (`~/.local/share/opencode/opencode-local.db`): `.tables` lists exactly
  those 20 base tables (incl. `__drizzle_migrations`, `event_commit_probe`). A
  scan of every `~/.local/share/opencode/*.db` and
  `~/.config/opencode/*.db` finds zero tables matching `%claim%`, `%loop%`, or
  `%inbox%`.

Loop state is entirely in-memory: `Ref<Map<LoopID, Record_>>`
(`src/loop/loop.ts:314`). Two processes, two directories, two checkouts — each
has its own in-memory map and no shared board. A claim written by member A in
checkout-1 is invisible to member B in checkout-2. There is also no inbox:
`Loop.Record` carries `steers: string[]` (`loop.ts:290`) but no `inbox` field.
Inbound messages have nowhere to land for a running member.

### Breakage 3 — no way to resume another member's worktree/branch

The `Worktree` service (`src/worktree/index.ts:119-126`) exposes:
`makeWorktreeInfo, createFromInfo, create, list, remove, reset`. There is **no**
method to resume/attach to an existing worktree by a recorded branch+directory.
`list()` returns currently-open worktrees but gives no hook to hand another
session into member A's branch. The queue's per-directory isolation is "derive
the cursor and switch branches in your own directory" (design D1) — it has no
concept of "member A's branch, worktree, gate" being picked up by member B.
Design.md §4's "resume abandoned work from the recorded branch/worktree/gate"
has no implementation. If member A is killed mid-change, member B has no
durable record of where A left off and cannot continue from there.

### Conclusions

- **Mid-turn**: a peer message is a competing turn. The loop's foreign-turn
  guard (loop.ts:356) skips the loop's own iteration, so the claim is lost
  either way. Fix: route inbound messages to a running loop's **inbox** instead
  of `prompt()` (design §4).
- **Board**: none exists. No `claims` table, no shared queue cursor, no inbox.
  Loop state is per-process in-memory. Fix: add a `claims` table (partial unique
  index on `projectID, slug WHERE releasedAt IS NULL`) and a shared cursor that
  skips claimed slugs (design §2, §Cursor).
- **Resume**: no worktree attach/ resume API. A killed member's branch, gate,
  and position are unrecoverable by another member. Fix: record branch/worktree/
  gate on the claim and add a resume path (design §4, §Abandoned).

These are the three gaps the claims + inbox + worktree-lifecycle phases close.
