# Findings: why the existing delegation path is unused

## Investigation

Task 0.1 instrumented every placement decision with structured logs:
- `placed subagent on idle local provider` — with provider, model, parent, requiredCtx, probed count, candidate scores
- `no idle local provider, inheriting parent` — with parent, probed count, candidate scores
- `placement failed, inheriting parent` — with error
- `delegated subagent task to idle peer` — with owner, peer, name, task
- `subagent capacity probe unreachable, inheriting parent anyway` — with provider

Code analysis of the decision path in `src/tool/task.ts:278-520` identifies three suspected causes for the path being unused. Here is which one dominates.

## Cause 1: narrow trigger — dominates

Delegation fires only when `parentCapacity === "no-slot"` (task.ts:508). The three possible return values from `parentCapacity` are:

| Return | Meaning | Delegation? |
|--------|---------|-------------|
| `"free"` | probe succeeded, slot available | no — inherit |
| `"no-slot"` | probe succeeded, no slot | **yes** |
| `"unknown"` | probe failed | **no** — inherit with warning |

A failed probe (network error, missing `/api/hardware`, older llama-skein) returns `"unknown"`, and the code explicitly chooses to inherit rather than delegate (task.ts:504-506):

```ts
if (capacity === "unknown")
  yield* Effect.logWarning("subagent capacity probe unreachable, inheriting parent anyway", {
    provider: inherited.providerID,
  })
```

This means any single-slot host that is unreachable, misconfigured, or running an older llama-skein silently inherits rather than delegating to a peer. The trigger is narrow by design — the comment says "failing closed there turns any transient probe blip … into a hard subagent failure" — but it is the primary reason delegation is rarely seen. In practice most local hosts are reachable and report a slot state, so this only blocks delegation in edge cases.

**Dominance: high for edge cases, moderate overall.** On a healthy fleet this is not the dominant cause, but it prevents delegation from being a reliable fallback.

## Cause 2: empty roster — fixed, not dominant

The roster was project-scoped until the 2026-09-19 fix (`claude-code-peer-source`). `resolveMessageTargets` now deliberately includes all sessions on the instance, not just those in the caller's directory (session/peers.ts:153):

```ts
// Deliberately NOT scoped to the caller's own directory: peers can be
// working anywhere, in any repo, on this instance
```

The test suite (`test/tool/task-delegate.test.ts`) confirms the path works end-to-end when peers exist: an owned idle opencode session on a cloud provider is the peer, and the reply resolves. With the roster fix applied, this is no longer a cause.

**Dominance: none (fixed).**

## Cause 3: free-slot-but-owned — moderate

`freeSlots` (local/placement.ts:63) compares `in_flight` against `slots_total` plus in-process reservations. It does not account for sessions that are bound to a host but currently idle between turns:

```ts
export function freeSlots(hw: ResourceSnapshot, reserved: number): number {
  const inf = hw.inference
  if (inf?.slots_total !== undefined && inf.slots_total > 0) {
    return inf.slots_total - (inf.in_flight ?? 0) - reserved
  }
  return (isBusy(hw) ? 0 : 1) - reserved
}
```

A single-slot host with a session between turns reports `in_flight=0, slots_total=1`, so `freeSlots` returns 1 — "free". `pick()` places the subagent there, which competes with the bound session's next turn and can force a model swap (evicting warm weights). This is the "free-slot-but-owned" problem the proposal describes.

This does not prevent delegation — it just means placement picks a host that looks free but isn't really, and the subagent runs on a host that will swap models. The peer delegation path is bypassed because `pick` succeeds (returns `"placed"`) even though the chosen host is a poor choice.

**Dominance: moderate.** This causes silent poor placement rather than delegation failure. It is the more important bug for user experience, but it does not explain why delegation is unused — it explains why placement sometimes picks a bad host instead of delegating.

## Conclusion

The **narrow trigger** (cause 1) is the dominant reason delegation is rarely seen. It fires only at `"no-slot"` and silently inherits on `"unknown"`, which covers any host that is temporarily unreachable or running older software. On a healthy fleet the trigger works, but the fleet is not always healthy.

The **free-slot-but-owned** issue (cause 3) is the dominant UX bug: placement places on a host that looks free but has a bound session, causing a model swap. This is what Phase 2 of this change addresses by joining sessions to hosts in placement and ranking accordingly.

The **empty roster** (cause 2) was the original problem and is now fixed.

## Implications for Phase 2 scope

Task 0.3 asks whether most of Phase 2 is unnecessary now that the roster is fixed. The answer is **no**:

- The narrow trigger (cause 1) requires widening the delegation condition beyond `"no-slot"` to also cover `"unknown"` and cases where `pick` returns a poor-quality placement.
- The free-slot-but-owned issue (cause 3) requires joining sessions to hosts in placement scoring so bound sessions are ranked below unowned hosts.

Both fixes are in Phase 2 and are independent of the roster fix.
