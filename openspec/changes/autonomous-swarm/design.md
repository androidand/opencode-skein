# Design: autonomous swarm

## Operating model (the target way of working)

```
human ──(talks to)──► LEAD session (any harness; skein MCP optional but typical)
                         │  grant: user-issued, durable, verifiable
                         ├── directs ──► member A  (opencode, worktree/branch X)
                         ├── directs ──► member B  (Claude Code, worktree/branch Y)
                         └── via skein conductor (re-engage, gates, claims)
members: claim → worktree → implement → tests → review-on-done → merge (per policy)
         blocked → ladder (self → owner peer → lead → blocker.md) ; human only if tagged
         done    → verified → notify lead → next item from board → else idle-watch
```

Three planes, kept separate on purpose:

| plane | owner | examples | trust source |
| --- | --- | --- | --- |
| thinking | LLM sessions | priorities, scope, "is the epic done", resolving a blocker | the lead's judgement |
| mechanics | skein conductor / loop driver | re-engage idle, enforce gates, send-once nudges, claim reaping | code + artifacts |
| authority | the user | who is lead, what may be published, what is never allowed | user-issued files |

Rule that ties them: a mechanism may *verify* authority, never *create* it.

## D1. Authority is a file the user wrote, verified by code

`lead-authority` defines `lead.json` (machine scope, mode 0600) created only by a
user-typed action (`/lead` in a TUI, or `skein lead set` run via the user's own shell —
in Claude Code, the `!` prefix). A model-callable tool can *read* it and can *request*
that the user issue one; it cannot write it. This is the line that keeps the way-of-
working rule against permission laundering intact: authority still never originates in a
peer message or a model's tool call.

Verification is mechanical and local. For opencode receivers it happens in code before
the message is rendered (the sender's authenticated socket → registry → session id,
compared with the grant). For Claude Code receivers it is one command the session's
instructions tell it to run (`skein lead verify --from <address>`), whose output is
GRANTED/DENIED and a scope, so the model never *judges* trust, it reads a result.

## D2. Scope, not blanket obedience

A grant carries scopes: `assign` (give me work from the specs), `sync` (rebase, merge,
report status), `reprioritise`, `decide` (answer a blocker). It never carries tool
permissions, secrets, or anything on the policy never-list. The receiver's own permission
rules still apply to every action. "Follow the lead" means "treat its directive as the
user's instruction for planning and ordering", not "act with extra rights".

No transitive trust: a directive is honoured only from the lead's own socket. A member
relaying "the lead says X" is a peer message like any other.

## D3. The escalation ladder (`escalate-before-idle`)

```
blocked(item)
  L0  decide from the spec/proposal; write the decision into tasks.md notes      (self)
  L1  ask the owner peer ONCE (request, with deadline); continue ANOTHER item     (peer)
  L2  deadline passed, no reply: request the lead ONCE                            (lead)
  L3  no lead or no answer: write .skein/blocker.md (needs: team|human), move on  (board)
  L4  only `needs: human` is shown to the human — as a pending decision on the
      board and in the lead's brief, never as a stopped session                   (human)
```

Properties: every rung sends at most once per `(item, rung)`; every rung ends with the
member doing something else, never waiting; `human` is reserved for goal ambiguity,
credentials, irreversible or never-listed actions.

## D4. Done is an event (`loop-done-handoff`)

`done` runs a pipeline instead of ending the run: verify evidence → `review-on-done` →
record verdict → notify lead (one `notify`) → release claim → pick next → if none,
`idle-watch` with backoff (woken by inbox, board change, new change). Terminal states
remain for cancel, error and an explicit operator stop, plus a bounded prompt-mode
opt-out (`--once`). A completion token is a *claim*; for spec-backed work the evidence is
checkboxes + gate results.

## D5. Standing publish authority (`standing-publish-authority`)

A per-repo, schema-validated policy file is the durable "explicit instruction for that
action". It is parsed with a closed schema and **fails closed at load**: a wrong type, an
unknown key or a visibility that disagrees with the forge disables every publishing grant
and says why. The never-list (force-push, history rewrite, visibility change, tags and
releases, other remotes, credential changes) is not overridable by the file. Rendered
three ways from one source: prompt text (replaces "never commit unless asked" with the
grant, scoped), permission rules (derived allow/deny), and a Claude Code fragment.

## D6. Cross-model review on done (`review-on-done`)

Trigger on done; review the named commit range; reviewer chosen to differ from the author
(harness, else model family), via the same routing as crew work; token verdict recorded as
`.skein/review.json` keyed by the reviewed SHA; merge policy requires an APPROVE for the
head SHA. Rounds are bounded (3) and then escalate to the lead through the ladder.

## Skein side (amendments to `live-session-conductor`, separate repo)

1. **D4 amended:** `skein_conduct start` succeeds only for a session that holds a valid
   grant (reads `lead.json`); otherwise it returns the one-line instruction for the user
   to run `! skein lead set`. The conductor's own claim record remains, but it is derived
   from the grant, not the other way round.
2. **Conductor identity:** the grant may name the conductor as delegate with scope
   `nudge` only, so followers can verify a nudge came from skein acting for the lead.
3. **Roster = peer registry:** the roster adapter reads the same sidecar registry
   opencode writes and the Claude session sockets, not claim-file globs (already Slice 1).
4. **Gate evidence:** `ReviewVerdict` evidence is the `.skein/review.json` record.
5. **Headless pool (new):** a spawn adapter that starts `opencode serve` per worktree or
   one server hosting several sessions, registers it in the roster, and leaves
   `opencode attach` as the human's way to talk to any member. Reuses skein's provider
   chains for model choice; the old fleet YAML shrinks to *spawn templates* only
   (role, repo, model chain) — presence comes from discovery, not from the file.
6. **Companion (opencode-skein):** a slug-bearing delegation from a granted lead starts a
   queue-mode loop for the slug (verified completion), acknowledges, and sends one
   completion notice — implemented as part of `loop-done-handoff` + `crew-loop` Phase 2/3.

## Why not make the conductor an LLM

The post-mortem of the first skein is explicit: coordination in a resident process with
its own agency failed for days unnoticed. The conductor's whole vocabulary stays "read
artifacts, send one peer message, write one artifact, raise one pending decision".
Anything needing judgement goes to the lead, which is what the lead is for.
