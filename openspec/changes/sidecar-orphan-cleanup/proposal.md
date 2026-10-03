# Proposal: sidecars that outlive their session

## Problem

A sidecar (`opencode debug claude-sidecar-entry`) is a separate OS process that receives
inbound peer messages over a unix socket and hands them to the session that spawned it. It
has its own lifetime, and the code has two mechanisms intended to keep that lifetime tied
to the session. On 2026-10-03 neither mechanism reclaimed **44 live sidecars** on one
machine, and they had to be killed by explicit PID.

The 44 were all `bun.exe run <deleted-worktree>/packages/opencode/src/index.ts debug
claude-sidecar-entry`, with `ppid 1`, ~16 hours old, sleeping, and **holding no session
database**. Every one was unroutable: `resolveOpencodeSender`
(`packages/opencode/src/peer/route.ts:203-208`) resolves a claimed address through the
registry, and none of these had a registry entry, so no peer could address them at all.
They were pure load — plausibly a contributor to the load spikes seen the same day.

## Why the two existing mechanisms miss them

**The sweep cannot, by design.** `sweepStaleSidecars`
(`packages/opencode/src/peer/claude/sidecar-registry.ts:98-126`) walks the registry
directory and removes an entry only when `!isAlive(parsed.pid)`. It removes *files for
processes that have already exited*. It never signals a live process. An orphaned sidecar
is alive by definition, so the sweep is structurally incapable of reclaiming one.

**The self-termination guard has a startup blind spot.**
`packages/opencode/src/peer/claude/sidecar-entry.ts:93-97`:

```ts
const originalPpid = process.ppid
const orphanCheck = setInterval(() => {
  if (process.ppid !== originalPpid) shutdown()
}, 2_000)
orphanCheck.unref()
```

This detects a ppid that *changes after startup*. If the parent dies **before the child
evaluates `process.ppid`**, the child is already reparented (to pid 1, or the nearest
subreaper). `originalPpid` then captures the reparented value, the comparison is false
forever, and the sidecar has no parent to signal it and no sweep that can see it.

There is a second ordering hazard behind the same outcome.
`packages/opencode/src/peer/claude/sidecar-manager.ts:121` spawns the child, and the
registration is written afterwards. A parent that dies in that window yields a process that
is both **unregistered** and **unreclaimable** — the worst combination, because the sweep
cannot even enumerate it.

## What is already covered, and what is not

`packages/opencode/test/peer/claude/sidecar-e2e.test.ts:222` covers the case the code was
written for: a parent that dies *after* the sidecar is up. It waits for the registration,
then exits, and asserts the sidecar self-terminates. Its own comment notes this is the
case a sweep cannot reclaim.

Neither of the observed failure modes is that case. Both are **startup races**: the parent
already gone when the sidecar begins running. No test covers either, and the guard's
structure means the already-orphaned case is not merely untested but undetectable by the
guard as written.

## The mechanism, confirmed and narrowed

Two peer sessions reproduced the race independently on Bun 1.3.14/macOS. The second
investigation narrowed the window, and the narrowing matters because it corrects this
document's original description.

The window is **not** "the parent dies before the child reads `process.ppid`" in the
abstract. In execution order:

1. `sidecar-entry.ts:37` — `await startSidecar(...)`, which is async and writes the
   registration from inside `sidecar-server.ts:156`.
2. `sidecar-entry.ts:93` — `originalPpid = process.ppid`.
3. `sidecar-entry.ts:94` — the poll interval starts.

So the blind window is the duration of `startSidecar`: from spawn until line 93. A parent
that dies anywhere inside it leaves `originalPpid` reading as 1, the comparison
`1 !== 1` false forever, and a sidecar that never self-terminates.

That window has two sub-cases, distinguished by whether the registration reached disk:

- parent dies **before** `writeSidecarRegistration` completes → alive, **unregistered**,
  invisible to the sweep and unroutable;
- parent dies **after** it, before line 93 → alive, **registered**, still skipped by the
  sweep because the sweep only removes registrations whose pid is *dead*.

All 44 observed instances were in the first sub-case (no registration), but both are real
and one fix covers both: the parent's stdin pipe closes at any point in the sidecar's
life, so EOF on a real pipe cannot be missed by any of these windows.

## Why this is a change and not a patch

The guard needs to know its spawner was real, not infer it from a ppid read that may already
be post-reparenting. Options differ in cost and in what they guarantee:

- pass the spawner's pid explicitly via the environment, and treat "spawner pid absent or
  not alive at startup" as immediate orphanhood;
- have the parent hold the socket and close it on exit, so the sidecar's accept loop
  observes EOF;
- add an explicit reaper that can identify and reclaim a live sidecar with no reachable
  parent, which requires a registry-independent notion of ownership.

The first is small and closes the window. The third is what would make the sweep able to
reclaim a leak that already happened on other machines, where no fix to new spawns helps.
Which of these to do is a decision, not an implementation detail.

## Scope

Process lifetime and cleanup only. Nothing here touches sender identity, lead grants, or
the review record; `review-on-done` Phase 1b depends on the identity question separately
and is tracked there.