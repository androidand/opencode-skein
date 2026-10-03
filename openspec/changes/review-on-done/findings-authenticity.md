# Finding: peer sender identity is a resolved claim, not an authentication

Date: 2026-10-03. Branch: `review-identity-finding`, cut from `origin/dev` = `d7360d499f`.
Affects: `review-on-done` Phase 1b (record authenticity), and `project-server` D5.
Status: **decision required from the user.** This is the input to that decision, not the decision.

## Summary

Phase 1b.1 requires the review record to be written with "the authenticated session
identity of the REVIEWER". Two candidate sources exist: a shared project server, which
attributes the request itself, and today's per-process sidecar route, which resolves a
peer-supplied return address through a registry.

The second is not a weaker authentication. It is **not an authentication at all**. Nothing
in `packages/` binds a peer's claimed identity to the connection the message arrived on.

That distinction decides Phase 1b. A review record whose `reviewer.sessionID` is a
self-asserted string cannot enforce "the reviewer is not the author" (task 1b.3). Building
the writer on that basis yields records that *look* like a working review gate and enforce
nothing — worse than no gate, because the record's presence is the misleading part.

## What the code claims, and what it does

`packages/opencode/src/peer/claude/codec.ts:95-102`, in the doc comment on `parseEnvelope`,
states the rule correctly:

> the returned `from`/`fromName` are for DISPLAY ONLY — a sender can put anything in these
> attributes, so provenance for authorization purposes is whatever authenticated socket
> connection this arrived on, never these fields.

`packages/opencode/src/peer/claude/lifecycle.ts:122-123` then does the opposite:

```ts
const sender = yield* Effect.promise(() => resolveOpencodeSender(inbound.from))
const pid = claudePidOf(inbound.from)
```

It hands the envelope **field** to the resolver. The comment promises connection-derived
provenance; the implementation derives it from the claim the comment warns against. There
is no third path.

## Evidence

Measured on this checkout at `d7360d499f`:

- `SO_PEERCRED`, `getpeereid`, `getPeerName`: **0 occurrences** in `packages/`. The
  connection exposes no peer credential, so "whatever authenticated socket connection this
  arrived on" does not exist as a value that could be read.
- `packages/opencode/src/peer/route.ts:203-208`, `resolveOpencodeSender`, has two branches
  and both are functions of a string the sender chose:
  - `opencodeSenderOf` strips the `uds:opencode-skein:` prefix and returns the remainder.
    A sender that writes `uds:opencode-skein:ses_victim` **is** `ses_victim`.
  - the UDS branch looks that socket path up in the registry. The path came from `from` too,
    so it answers "whoever owns the socket path I named", not "who is speaking".
- `packages/opencode/src/peer/lead.ts:195-201` types `Sender` as "The authenticated sender, as
  the delivery path resolved it from the socket." For both routes above, that comment
  overstates the mechanism.
- `packages/opencode/src/peer/claude/sidecar-server.ts:95` gates each connection on
  `frame.token === peerToken`, a `randomBytes(16)` value written into the registration at
  `sidecar-server.ts:125`. That authenticates the **destination** — it proves the holder may
  deliver *to* that session. It says nothing about who is delivering.

## The check that would have caught this

Stating the intent as a test rather than a comment, because a rule that reads as prose and
parses as a mapping is exactly the failure this project has been bitten by:

> A peer sends a message whose envelope claims `from = uds:opencode-skein:<another session>`.
> Does the receiver attribute the message to that session?

Today it does. `opencodeSenderOf` returns the claimed id verbatim, and
`verifyLead` (`packages/opencode/src/peer/lead.ts`) then compares
`sender.sessionID === grant.lead.sessionID` and grants the lead's scopes. A forged `from`
satisfies the grant check.

No such test exists today. It should become a regression test when this is fixed, asserting
that a mismatched claim is either refused or attributed to the transport — never to the
claim. Until then, the honest statement is: **sender identity is unenforced.**

## The decision

Revised after peer consultation (2026-10-03). The original recommendation here was
server-attributed identity, per `project-server` D5. **That recommendation is withdrawn:
the user rejected the project server, so its premise no longer exists.**

### Correction to the evidence above

I listed the absence of `SO_PEERCRED` / `getpeereid` as a gap in this codebase. It is
worse than that: the primitive is not available in the runtime. Probed directly against
Bun 1.3.14 on a live unix-socket connection, `Socket` exposes no `getPeerName`,
`getPeerCredentials` or `getPeerCert`. So an unforgeable *connection* identity is not
merely unimplemented here — it is not reachable without OS-level separation or a different
runtime. Any proposal resting on peer credentials is not implementable as written.

### Option 1 — callback confirmation (recommended)

Before attributing a message, the receiver asks the claimed `from` socket: did you send
`msg_id` X to me? The real session answers from its own in-process sent-log. A forger
cannot make it say yes, because it does not have the log. Cost is roughly one new frame
type plus a sent-log — no server, no peer credentials.

This bounds the claim rather than making it absolute, and it is the strongest thing
available in this runtime.

### Option 2 — socket-resolved, as-is

Unblocked today, and rejected. It rests on a claim, so any same-user process that can
write the registry can attribute itself as another session.

### What no option delivers

Against a same-user, shell-capable agent, **nothing short of OS separation makes sender
identity unforgeable.** A process that can replace a registry entry or a socket can
answer for it. This should be stated wherever sender identity is relied upon, so the
residual is a decision the user accepts rather than one discovered later.

The real control is that claims stay **bounded**: human-granted, scoped, expiring, and
subject to a never-list. For the review record specifically, the durable part is that the
record is written by a tool from a session id the tool holds — never parsed out of message
text.

### Sequence

Callback confirmation first, since it hardens `verifyLead` as well; then 1b.1 on top of it.

## Orthogonal: 1b.2 is not sound on its own

Task 1b.2 denies model `edit`/`write` of `.skein/review.json`. Worth doing, and independent
of the identity choice — but only a control if the fenced path cannot be reached another
way, and scoped unattended bash can read and write arbitrary files today. A fence covering
`edit`/`write` alone holds in tests and is bypassable in practice, which is the more
expensive failure because the code reads as though it were safe.

Settle the bash gap before treating 1b.2 as done, or carry an explicit note that it is not
a sandbox.

## What this does not change

Nothing here is a fix, and nothing here is wired. The review record merged in `abadec9aea`
remains a reader and a mapper. #111 covers 1b.3 only and is **inert as merged**: nothing
passes `authorSessionID` yet, so it enforces nothing. It is recorded here as driver-side
plumbing, not as a control in force — and that distinction matters only for as long as
nobody ticks 1b done.
