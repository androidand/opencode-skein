# Tasks: fit-mark-sync

- [x] 1. Write the failing test first, at discovery level: two instances, same `providerID`/`modelID`; pass 1 has a fit report (`max_safe_ctx` 67,174 over a raw `context_length` 81,920), pass 2 has no fit report and a provider state with no retained value for the model. Pass 1 must show 67,174 / marked / 65,126; pass 2 must show 81,920 / **not** marked / 73,728. It must fail before the change.
    **Result (2026-11-28):** `packages/opencode/test/provider/fit-context-verdict.test.ts`, driven through the real `Provider.use.list()` discovery path (`discoverModels: true`, `Bun.serve` mock of `/v1/models` and `/api/fit`). Red observed before the fix, on the load-bearing assertion:
    ```
    expect(Provider.isFitDerivedContext(providerID, MODEL)).toBe(false)
    Expected: false
    Received: true
    ```
    with `stale.models[MODEL].limit.context` already 81,920 — i.e. the raw number was adopted while the trim's verdict survived, which is the 79,872 threshold case. Green after the fix: `1 pass, 0 fail`.
- [x] 2. Make the discovery pass derive the verdict from the value it assigned: `true` only when this pass set `context = fit.maxSafeCtx`, `undefined` only when the conservative retained-value branch fired, `false` otherwise.
    **Result (2026-11-28):** the `noteFitDerivedContext` call in `discoverOpenAICompatibleModels` now reads `fit?.maxSafeCtx ? true : context === previouslyKnownContext ? undefined : false`. The `undefined` case is reachable only from the branch that re-used `previouslyKnownContext`, so the "a lost probe must not widen a trimmed budget" rule stays exactly where it is load-bearing, and a raw `context_length` adopted with nothing behind it clears the mark. Doc comment on `noteFitDerivedContext` rewritten: the verdict is a claim about the assigned number, not about fit data in general.
- [x] 3. Confirm the conservative branch is unchanged: a fit-derived model re-discovered without a fit report, with its trimmed value retained, keeps both the value and the verdict.
    **Result (2026-11-28):** `context === previouslyKnownContext` is the retained branch's own condition, so that pass passes `undefined` and the verdict survives; `test/session/overflow.test.ts` (7 tests, including "clearing the verdict restores the full reserve" and the 65,126 / 63,078 boundary cases) still passes, and `test/provider` shows no new failures.
- [x] 4. Prove the remaining failures are pre-existing rather than blaming them.
    **Result (2026-11-28):** branch run `bun test test/session/overflow.test.ts test/provider`: 581 pass, 5 fail (`ProviderTransform.options - gpt-5 textVerbosity > azure…`, the minimax anthropic thinking-toggle variants test, two `opencode loader keeps paid models…`, `Bedrock Mantle: GPT-5.5 uses Responses API and OpenAI base path` at ~5,000 ms). Baseline: a detached `origin/dev` worktree, fresh `bun install`, `bun test test/provider`: 573 pass, 5 fail — the **same five test names** (the two runs differ only in that the branch run also included `overflow.test.ts`, hence 573 vs 581). So all five are pre-existing on `634458f0d69`, and the Bedrock one is a timeout in both.
- [x] 5. Run the gates.
    **Result (2026-11-28):** `bun run typecheck` in `packages/opencode` passes. `bun test test/session/overflow.test.ts test/provider`: 581 pass, 5 fail — the same pre-existing five. New test file registered in `fork/manifest.json` (`owned`); `bun run fork:verify` reports `290/290 owned present, 118/118 patched intact, 0 unregistered`. `openspec validate fit-mark-sync` passes.
- [x] 6. Record the finding's origin so the reasoning is not lost: a peer review, independently verified, on a merged change.
    **Result (2026-11-28):** recorded in `proposal.md` with the peer session id, the narrowing arithmetic (why the retained-value case is safe and only the nothing-retained case is dangerous), and the 413 ceiling numbers.
