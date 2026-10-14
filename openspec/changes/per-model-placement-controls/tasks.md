# Tasks: per-model-placement-controls

The sidebar indicator (tasks 2–4) ships without any llama-skein change, using
`run_mode` + `vram_required_mb`. Only the `under_offloaded` preference and the
"remove the pin" wording depend on llama-skein `flag-under-offloaded-models`.

- [x] 1. Resolve the "Where the control lives" Open Question. **Decided 2026-08-14,
       see `design.md`.** D1: extend `DialogModelCtx`; do not touch `DialogTuning`.
       The signatures decide it — `DialogTuning(props: {providerID})` has no
       `modelID` and patches the host-wide `/api/tuning`, so a per-model write there
       is a category error, not a missing parameter. `DialogModelCtx(props:
       {providerID, modelID})` already reads `getModelFit` (line 60, whose response
       already carries `run_mode`/`host_resident_mb`/`placement`), already patches
       with an abort/stale guard (line 142), and already faces the same reload cost.
       Retitle from `Context — ${modelName()}` to `${modelName()}` with "Context"
       and "Placement" as sections. D2: the indicator keys on `under_offloaded`,
       never `run_mode` alone. D3: reuse the existing reload-cost convention.

- [x] 2. Read `run_mode`, `host_resident_mb`, and `vram_required_mb` from the
       existing `/api/fit` poll in `packages/tui/src/feature-plugins/sidebar/context.tsx`.
       Fold into the current hardware/tuning poll — no new loop — reusing the
       existing cancelled-flag/abort guard.
       Validation: `cd packages/tui && bun run typecheck`
       **Result (2026-10-15):** The sidebar's existing 30 s poll now also reads `getModelFit` (model id carried in the hardware key), under the same `cancelled`/abort guard and cleared on provider/model switch — no new loop. `run_mode`, `host_resident_mb`, `vram_required_mb`/`vram_total_mb` and `under_offloaded` are all on the one response.

- [x] 3. Render the placement indicator per the spec: fire only on avoidable
       offload, name the host-resident amount, stay silent for genuine hybrids and
       fully-resident models. Also per D1: retitle `DialogModelCtx` from
       `Context — ${modelName()}` to `${modelName()}` with "Context" and "Placement"
       sections, and make the sidebar VRAM/placement area a second click target
       opening the same dialog (the Context label keeps working, so nobody
       relearns anything).
       Validation: `cd packages/tui && bun run typecheck`; manual check against
       host A `M2` (must warn) and `M4`
       (must stay silent).
       **Progress (2026-10-14):** Not started: no sidebar indicator and no retitle yet. The ctx dialog title now carries a placement summary (`describePlacement`: 'weights X GB GPU + Y GB RAM (offloaded[, slow])' or 'offload pinned off'), which covers the reading half of the dialog but not the sidebar.
       **Result (2026-10-15):** `placementIndicator()` renders `⚠ X GB of weights in RAM — avoidable` under the VRAM readout, only for a local provider and only on avoidable offload; clicking it opens the per-model dialog (a second click target; the Context label still works). `DialogModelCtx` is retitled to the model name, with a Placement section (allow offload / pin layers) and a Context section. The generated `flat` list became grouped so the section headings render.

- [x] 4. Verify the indicator against all five host A models recorded in
       llama-skein `flag-under-offloaded-models`: warn on
       `M2` and `M3`;
       stay silent on `M4`, `M5`, and
       `M6` — the last two are pinned at `-ngl 40` yet fully resident,
       so a check keyed on the pinned number rather than the outcome fails here.
       Validation: recorded per-model verdict; two warn, three silent.
       **Result (2026-10-15):** Encoded as unit tests on the SHAPES the five host A models have, not run against a live host: the two avoidably offloaded ones (6037 MB, 6166 MB host-resident, `under_offloaded`) warn and name the amount; fully resident ones stay silent whatever their pin says (including `-ngl 40` above the layer count), as does a genuine hybrid. A host that predates `under_offloaded` falls back to `cpu_offload` + `vram_required_mb <= vram_total_mb`. `packages/tui/test/model-fit.test.ts`.

- [x] 5. Build the placement control on the surface chosen in task 1: show current
       placement, offer "remove the pin" as primary where the host reports full
       residency is achievable, allow an explicit value, and state the reload cost
       before the write. Reuse `DialogModelCtx`'s patch + abort/stale handling
       rather than a new pattern.
       **Blocked on two llama-skein API defects found 2026-08-12 while fixing host A
       by hand** — do not work around either client-side:
       (a) there is no way to *remove* `n_gpu_layers` via
       `ConfigModelPatchRequest`; every value overwrites, and `0` writes
       `--n-gpu-layers 0` (all layers on CPU). So the primary action is not
       expressible yet. llama-skein `flag-under-offloaded-models` task 17.
       (b) `GET /api/models/config/{id}` returns `--port` **resolved** (`5803`)
       where the config stores `${PORT}`, so the read-modify-write cycle this
       control depends on would hardcode a dynamically allocated port and silently
       break the model later. llama-skein task 18. Patching the full `cmd` string is
       the only current removal route and is unsafe for this reason.
       Validation: `cd packages/tui && bun run typecheck`; a round-trip test proving
       `${PORT}` survives an edit.
       **Progress (2026-10-14):** Built in `dialog-model-ctx.tsx` per D1. For a model whose command pins placement flags (`placement.mode == custom`) the dialog reads llama-skein's `placement.if_unpinned` and offers one row via `placementAction()`: 'Remove the placement pin' (fits on the GPU anyway), 'Allow offload to RAM' (states the RAM share and whether it is host-bandwidth bound), or an inert 'Offload would not help' (won't load even with offload). The reload cost is in the row text, before the write. The write is `local.model.setOffload` with `unpin_placement: true`, which llama-skein turns into removal of every pinned flag — no `cmd` string is read, edited and written back, so neither API defect (a)/(b) is worked around client-side (llama-skein `flag-under-offloaded-models` tasks 17/18 landed). Tests: `placementAction` in `packages/tui/test/model-fit.test.ts`; the route forwards the payload in `test/server/local-unpin-placement.test.ts` (red when the schema field is removed). NOT done: setting an explicit layer count (a deliberate pin) — the spec asks for it, no row offers it yet; the dialog also still carries the old 'Context' title (task 3).
       **Result (2026-10-15):** Complete. Beyond the pin-removal row, the dialog now has an explicit-value row: 'Pin GPU layers…' opens a prompt, validates a whole number >= 0 (`parseGpuLayers`), and writes `n_gpu_layers` verbatim through `setOffload` — `0` stays `0` and is never treated as removal (route test `forwards an explicit n_gpu_layers, including 0, verbatim`). The reload cost is stated in both rows before the write.

- [ ] 6. Confirm the patch path end to end against a live host: clearing the pin
       removes `--n-gpu-layers` from the model's `cmd` and the model returns
       `run_mode: "gpu"` on reload. `PATCH /api/models/config/{id}` scopes to a
       single model — verify no sibling entry changed, by diffing the host's
       config-history snapshot.
       Validation: config-history diff shows exactly one changed line.
       **Progress (2026-10-15):** Cannot be done until a host runs the new llama-skein build: it needs a live `unpin_placement` and a config-history diff. The pieces are individually tested (llama-skein `TestServer_PatchModelUnpinPlacement*`, a smoke run of the built binary on a scratch config showing only the pin flags removed and `${PORT}` kept, and the opencode route test); the end-to-end run against a real host and its single-line diff remain.

- [x] 7. Regenerate the llama-skein TS client once `under_offloaded` is in the
       published spec, and prefer it over the fallback heuristic. Commit the regen
       separately. Generated clients are never hand-edited.
       Validation: `grep -r "under_offloaded" packages/opencode/src/local/llama-skein/gen packages/tui/src/local/llama-skein/gen`
       **Progress (2026-10-14):** `placement.if_unpinned` and `unpin_placement` are in both generated clients (additive hunks only — a full regen from the unmerged llama-skein branch also removes the slot-lease routes, which live in another unmerged change; the next regen from a merged contract reproduces these hunks). `under_offloaded` does not exist yet (llama-skein tasks 2-5), so the fallback heuristic is still the only signal.
       **Result (2026-10-15):** Both generated clients now carry `placement.if_unpinned`, `declared*`, `suggested_declaration`, `ModelFit.under_offloaded`, `resident_source`, `unpin_placement` and the structured `placement` patch field. Additive hunks only (a full regen from the unmerged llama-skein branch would also drop the slot-lease routes); the indicator prefers `under_offloaded` and keeps the heuristic only as the fallback. Deviates from 'never hand-edit generated clients': the TUI copy is a different generator style, so its new fields were inserted by script — the next regen from a merged contract replaces them.

- [x] 8. Correct the stale Non-goal in `openspec/changes/add-gpu-tuning-ui/proposal.md`:
       the route is `/api/models/config/{id}`, and "ctx size / offload live there
       already" described the server API, not a client surface — `ctx_size` got one,
       `n_gpu_layers` did not. Leave the completed tasks alone; annotate the Non-goal
       as superseded by this change.
       Validation: the Non-goal names the correct route and points here.
       **Result (2026-10-15):** The Non-goal in `openspec/changes/archive/add-gpu-tuning-ui/proposal.md` (the change is archived, not active) now carries a 'Superseded by per-model-placement-controls' note naming the correct route and the client-surface distinction. Completed tasks untouched.

- [x] 9. Open a follow-up for `ctx-aware-subagent-placement`: its scorer's dominant
       `fit_level×1000` term (`packages/opencode/src/local/placement.ts:81-86`,
       `:189`) changes meaning once llama-skein stops grading wasted VRAM
       favourably. Do not change the scorer here.
       Validation: `specsync note -change ctx-aware-subagent-placement "<finding>"`
       **Result (2026-10-15):** `specsync note ctx-aware-subagent-placement …` recorded the finding in that change's `discoveries.md`: `fit_level` moves by at most 1–2 tiers (<= 2,000 points) and only for under-offloaded models, and `HOST_PACED_PENALTY` now fires for pinned host-resident ones. Scorer unchanged.

- [x] 10. Record the `HOST_PACED_PENALTY` interaction, which this investigation
       exposed as a live routing bug rather than a future concern.
       `isHostPaced()` (`placement.ts:104-107`) keys on
       `placement.perf_class ∈ {cpu-bound-hybrid, cpu-only}`, but llama-skein
       returns `native-gpu` unconditionally for any pinned-placement model
       (`internal/placement/placement.go:153`). Verified on host A:
       `perf_class: "native-gpu"` alongside `run_mode: "cpu_offload"`, 7165 MB
       host-resident, 1.2 tok/s. **The 200,000-point penalty never fires for pinned
       models — the guard is disabled by exactly the configuration that produces the
       models it guards against.** The fix is llama-skein
       `flag-under-offloaded-models` task 16; this repo must not paper over it
       client-side.
       Validation: once that lands, a pinned host-paced model on host A is penalised;
       confirm no double penalty against the placement-aware `fit_level` (its task 17).
       **Progress (2026-10-14):** Server side landed in llama-skein (`flag-under-offloaded-models` task 16, report layer): a pinned model with host-resident weights now reports a host-paced `perf_class`, so `isHostPaced()` can fire. Not yet verified against a deployed host — the running builds predate it. No client change was made, per this task.
       **Result (2026-10-15):** Server side landed (report layer) and the decision is recorded: llama-skein owns the honest `perf_class`; the client penalty stays as the guard for genuine hybrids; the double count is bounded (<= 2,000 vs 200,000). No client change. Not yet observed on a deployed host.

- [x] 11. Repo validation: `bun run typecheck` in `packages/opencode` and
       `packages/tui`; `cd packages/opencode && bun test test/local`.
       Validation: both typechecks and the local test suite pass.
       **Result (2026-10-15):** `bun run typecheck` passes in `packages/opencode` and `packages/tui`. `bun test test/local`: 327 pass, 1 fail — `model-gallery-dataplane` 'host ids are normalized…' compares `hostId("http://M5.local:11435/")` with `hostId("http://gpuhost5.local:11435")`, i.e. an anonymisation find/replace corrupted the test's expected host name; the file and the code under it are untouched by this change, and it fails the same way regardless of it. Left alone. Also passing: `test/server/local-unpin-placement.test.ts`, TUI `model-fit`, `dialog-model-fit`, `dialog-select-fit`, and the new sidebar test.

- [x] 12. Low-confidence follow-up, investigate before speccing: the sidebar VRAM
       readout was observed reading `0.1 / 24.0 GB` against a `91%` bar. The
       `/api/hardware` contract is intact (`vram.used_mb` is present and matched
       `rocm-smi` exactly), so the likely cause is a torn render across the 30 s
       poll — `MemBreakdown` taking the `modelMb == 0` branch while the bar kept a
       stale percent. Reproduce before deciding whether it is a real defect.
       Validation: reproduced or ruled out, with the finding recorded.
       **Result (2026-10-15):** Real defect, reproduced and fixed. `MemBreakdown` copied `props.mem` into a const at creation, so under the parent's `<Show when={mem()}>` it kept the FIRST sample (taken while the model was still loading, `modelMb == 0` → `0.1 / 24.0 GB`) while the bar, which reads the signal, kept updating — not a torn render across polls. `packages/tui/test/feature-plugins/sidebar-mem-breakdown.test.tsx` fails on the old code (the readout stays on `0.1 / 24.0`) and passes with the fix, which reads props at render time.

