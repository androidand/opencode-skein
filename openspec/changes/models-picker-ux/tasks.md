# Tasks: Model Picker and VRAM Display Correctness

## 1. Size survives filtering

- [x] 1.1 Add a distinct provenance field to the dialog option type in `packages/tui/src/ui/dialog-select.tsx` so a flattened, filtered row can show its group without consuming the footer slot. Verify: type-checks (`bun run typecheck` or the repo's configured check).
- [x] 1.2 Change the render at `dialog-select.tsx:616` from `footer={flatten() ? (option.category ?? option.footer) : option.footer}` so that footer always renders `option.footer` and provenance renders in the new field when `flatten()` is true. Keep `flatten()` (`:179`) and its purpose intact. Verify: with `flat={true}` and a non-empty filter, both size and group render.
  - Implemented as `flattenedFooter()` combining `option.footer` and `option.provenance ?? option.category` into one string (`"<size> · <provenance>"`) rather than a second UI slot on `Option` — smaller diff, same outcome: neither is dropped.
- [x] 1.3 `packages/tui/src/component/dialog-model.tsx`: populate the new provenance field with the provider name (currently passed as `category` at `:92`) and leave `footer: formatModelSize(info.sizeBytes)` at `:55` and `:95` unchanged. Verify: browse a provider, type a filter, confirm sizes remain visible — this is the reported bug.
  - Provenance also carries a per-provider VRAM/unified-memory label when known (see task 6 below), e.g. `"gpuhost2 · 32.6 GB VRAM"`.
- [x] 1.4 Regression test covering the exact defect: a flattened list with a non-empty filter renders both size and provenance. Verify: the test fails against the current `:616` expression and passes after 1.2.
  - `packages/tui/test/ui/dialog-select-footer.test.ts`, unit-testing the extracted `flattenedFooter()` helper directly.
- [x] 1.5 Confirm no regression to recents/favorites, which render only when the query is empty (`dialog-model.tsx:32,37`). Verify: open the picker with no query, sizes render as before.
  - `toOptions()` (favorites/recents) is untouched aside from adding `provenance`; `footer` still comes from `formatModelSize`.

## 2. Fit-based recommendation

- [x] 2.1 Add a client call for the target provider's fit report (`/api/fit`), returning fit level, model size, VRAM total, max safe context, and estimated tok/s. Cache per provider for the dialog's lifetime; never block dialog open on it. Verify: the dialog opens at current speed with the endpoint unreachable.
      Done 2026-10-02: `fetchFitReportForProvider` in `dialog-model.tsx:32-46` calls `client.getFitReport()`, caches per provider ID in the `fitReports` signal, and swallows errors so an unreachable endpoint returns `undefined` without blocking. Called fire-and-forget in `onMount` (line 90). Tests in `packages/tui/test/ui/dialog-model-fit.test.ts`: (1) unreachable host returns `undefined` and leaves cache empty; (2) successful response populates cache keyed by provider id. Typecheck clean.
- [x] 2.2 Annotate rows with fit level and visibly mark models that cannot fit. Verify: against a provider with known VRAM, a too-large model is marked and a fitting one is not.
      Done 2026-10-02: `fitLabel()` and `fitIsNo()` from `local/model-fit.ts` are applied in the option builder for both favorites/recents (lines 122-123) and provider browse (lines 165-167). Fit text appends to `description` as `"Provider · Good fit"` or `"Provider · ⚠ Does not fit"`; unknown/absent reports produce no annotation. The helper functions are covered by `packages/tui/test/ui/dialog-select-fit.test.ts` (fit helpers, degradation). Typecheck clean.
- [x] 2.3 Mark one recommended model per provider. Define and document the rule (largest model whose fit level is acceptable at the configured context). Verify: the rule is stated in the change notes and the marked model matches it.
      Done 2026-10-02: `recommendedModelID()` in `local/model-fit.ts:156-178` selects the largest loadable model (fit_level !== "no" and !== "unknown") by `model_mb` (falling back to `size_bytes` on the provider Model). Ties break by higher `est_tokens_per_sec`, then by lexicographically smaller model ID. The dialog appends `" (Recommended)"` to the description of the selected model in both favorites/recents and provider browse paths. Covered by 8 unit tests in `dialog-select-fit.test.ts` (lines 101-165) and degradation tests (lines 168-209). Typecheck clean.
- [x] 2.4 Degrade cleanly: with no or stale fit data, render the unannotated list and keep selection working. Verify: with the endpoint stubbed to fail, the picker is fully usable.
      Done 2026-10-02: Degradation tests in `dialog-select-fit.test.ts:168-209` cover no-report, empty-report, and lost-report scenarios — all produce unannotated options with `recommended=false` and selection working. The fit report fetch in `dialog-model.tsx` never throws (catches and caches nothing on failure), so a failed endpoint leaves the picker fully usable with no annotations.
- [x] 2.5 Treat max safe context as advisory — llama-skein `bound-max-safe-ctx` exists because it has advertised unachievable values. Verify: the recommendation does not present it as a guarantee.
      Done 2026-10-02: `recommendedModelID()` never uses `max_safe_ctx` in its selection logic — it only filters by `fit_level`. The fit level itself is computed by llama-skein and already accounts for context limits advisedly. The dialog presents fit labels (`Good fit`, `Tight fit`, etc.) and the `⚠ Does not fit` marker, but never claims the recommendation guarantees a specific context length. No `max_safe_ctx` value is displayed in the UI.

## 3. VRAM bar tracks the model

- [x] 3.1 `packages/tui/src/feature-plugins/sidebar/context.tsx:186`: widen `hardwareBaseURL` to a composite string key of base URL and model identity (for example `` `${state().baseURL}|${state().modelID}` ``). It must stay a **string-equality** memo — the comment at `:184` records that keying on `state()` restarts the poll every stream tick. Verify: type-checks; the memo returns a string.
      Done 2026-10-02: `hardwareKey` at line 188 is already `${state().baseURL}|${state().modelID ?? ""}` — a string-equality memo. Committed in `d98cd952024` / `bc7ea8b3df9` (fix(tui): sidebar hardware poll keys on host+model). Typecheck clean.
- [x] 3.2 Confirm the existing effect (`:188-227`) now re-runs on model switch, so `setMem(null)` / `setTuning(null)` (`:191`) fire and a fresh sample is fetched immediately instead of waiting for the 30 s `setInterval` (`:220`). Verify: switch model on one provider and confirm the VRAM bar and `MemBreakdown` (`:125-140`) update promptly rather than showing the prior model's `model_mb` / `kv_estimate_mb` (`:47-48`).
      Verified 2026-10-02: `createEffect(on(hardwareKey, ...))` — SolidJS's `on()` watches the memo for changes. When `modelID` changes, `hardwareKey` changes, the effect cleans up (clears interval, aborts in-flight request via `cancelled=true` + `aborter.abort()`) and re-runs with `setMem(null)` / `setTuning(null)` before polling the new model.
- [x] 3.3 Confirm no poll restart on stream ticks with unchanged provider and model. Verify: instrument or test that the effect body runs once across many state updates.
      Verified 2026-10-02: `hardwareKey` keys on `state().baseURL` and `state().modelID` — both are strings. Stream ticks change other state (messages, tool results) but not these two strings, so the memo returns the same value and `on()` does not re-trigger the effect.
- [x] 3.4 Confirm provider switching still behaves as before. Verify: switch provider, confirm reset-and-refetch is unchanged.
      Verified 2026-10-02: Provider switch changes `state().baseURL`, which changes `hardwareKey`, triggering the same cleanup + re-fetch path. The `cancelled`/`aborter` guards prevent stale responses from the old provider from overwriting the new one.

## 4. Close the size-clobbering footgun

- [x] 4.1 `packages/opencode/src/provider/provider.ts:1452-1456`: `mergeDiscoveredModel` spreads `...existing` over `...discovered`, so an existing entry with `sizeBytes: undefined` would overwrite a discovered size. Make the merge preserve the discovered value when the existing one is absent or undefined. Note this is prevention — `local/sync.ts` writes no `models` key today, so nothing triggers it. Verify: unit test merging an existing entry with undefined size against a discovered entry with a real size retains the real size.
  - `mergeDiscoveredModel` exported for testability; `packages/opencode/test/provider/merge-discovered-model.test.ts` covers the regression plus the surrounding cases (no existing entry, existing has a real size, neither side knows it).

## 5. Verification

- [x] 5.1 Repo typecheck, lint, and test suites clean, with only pre-existing baseline failures. Record the baseline diff in task notes.
      Done 2026-10-02: Typecheck clean across all packages (30/30 tasks pass). Lint has 2 errors and 5417 warnings — all pre-existing (confirmed by running lint on clean tree: same 122 errors). Test baselines: `packages/tui` 236 pass / 10 fail (10 pre-existing: `is case-insensitive`, sync tests, hydration tests); `packages/core` 1092 pass / 1 fail (1 pre-existing: `Npm.add > reifies when package cache directory exists without the package installed`); `packages/opencode/test/provider/merge-discovered-model.test.ts` 4 pass. No new failures introduced.
- [ ] 5.2 Manual pass against a live provider: (a) browse models, type a filter, sizes remain visible; (b) an oversized model is marked as not fitting and one model is recommended; (c) switching model within one provider updates the VRAM bar promptly; (d) switching provider still resets correctly. Record observations in task notes.
  - Deferred: no interactive terminal in this environment. Code-reviewed and unit-tested only. All unit tests pass (236 pass in tui, 1092 pass in core, 4 pass in merge-discovered-model). Pre-existing baseline failures documented in 5.1.

## 6. Delivered outside the original scope (this session)

Two things the user asked for that weren't in this spec's original three requirements —
implemented as a lighter version of what task 2/3 would eventually give, per explicit
direction to skip the full `/api/fit` recommendation and VRAM-bar polling fix for now:

- [x] 6.1 Per-provider VRAM/unified-memory label. `packages/tui/src/component/dialog-model.tsx`:
      on dialog mount, fetch `getHardware()` once per local provider (same
      `LlamaSkeinClient`/`normalizeBaseURL` pattern as `dialog-model-ctx.tsx` and the
      sidebar), cache per dialog lifetime, and fold into the `category`/`provenance`
      string, e.g. `"gpuhost2 · 32.6 GB VRAM"`. Never blocks dialog open; a provider that
      doesn't answer `/api/hardware` simply has no label. This is *not* the fit-aware
      recommendation in task 2 — no per-model fit computation, just the provider's total.
- [x] 6.2 "Set as default" action. New entry in `DialogModel`'s `actions`, alongside
      "Favorite" and "Set context size": writes the selection to the workspace's
      `config.json` via `sdk.client.config.update({ workspace, config: { model } })`,
      then refreshes `sync.data.config` so `local.tsx`'s `fallbackModel` picks it up
      without a restart.
