## Why

`local-fit-double-reserve` (PR #139) made `usable()` reserve a small 2,048-token buffer for models whose `limit.context` came from a llama-skein fit report. The verdict that drives it was written from the wrong evidence: the call site recorded whether a **fit report existed**, not whether **this pass actually assigned `context = fit.maxSafeCtx`**. `usable()` takes the buffer from the verdict alone, and the two are not kept in sync.

`fitDerivedContextModels` is a module-level `Set`, while provider/model state is per-instance. So the verdict outlives the number it described:

- Pass 1 (instance A, fit available): `limit.context = 67,174`, verdict `true`, `usable()` 65,126. Correct.
- Pass 2 (instance B, same `providerID`/`modelID`, provider state has no previous value for the model, `/api/fit` unavailable): the conservative `previouslyKnownContext` guard is absent because there is nothing retained, so the raw `context_length` 81,920 is adopted — while the stale verdict keeps the 2,048 buffer. `usable()` returns 79,872 against a host that answers **413 above 67,174**.

That is the exact failure mode the pre-existing conservative guard exists to prevent ("a too-large budget silently wedges every request behind a 413 the client never recovers from"), reintroduced through the compaction threshold instead of through `limit.context`.

A peer review of PR #139 (session `ses_ddfd66b52ffeWnwgvyBlMgxNpx`, 2026-11-28) found this and independently listed the conditions; the arithmetic narrows it to one unsafe path — where a raw value is adopted with **nothing retained behind it**. When a previously-known trimmed value is retained, or the reported value is at or below the trim, the threshold cannot exceed the ceiling and the stale verdict costs nothing.

## What Changes

- The discovery pass records the verdict from the value it assigned: `true` only when this pass set `context = fit.maxSafeCtx`; `undefined` (keep the previous verdict) only when the conservative branch re-used a previously-known value, whose provenance the registry already records; `false` otherwise, clearing a verdict that no longer describes the number.
- The "a lost probe must not widen a trimmed budget" rule is kept exactly where it is load-bearing — the retained-value branch — and is no longer applied to a number that was never trimmed.
- No change to `usable()`, to the size of the buffers, or to non-fit providers.

## Impact

- `packages/opencode/src/provider/provider.ts` — the `noteFitDerivedContext` call site in `discoverOpenAICompatibleModels`, and the doc comment on the registry.
- New fork-owned test `packages/opencode/test/provider/fit-context-verdict.test.ts`.
- Depends on `local-fit-double-reserve` (PR #139, merged as `634458f0d69`); the defect it fixes was introduced there.
- No API, SDK or TUI change.
