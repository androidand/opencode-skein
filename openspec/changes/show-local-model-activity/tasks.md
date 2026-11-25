# Tasks: show-local-model-activity

Blocked on llama-skein `add-model-activity-reporting` for real data; develop against a fake host first.

- [ ] 1. A UI-free module that turns a host activity record (or a `prompt_progress` stream chunk) into a display model: phase, percent, counts, rate, ETA, stalled text, cache note. Verify: `bun test` with fixtures taken from the host's recorded `/slots` series; each case observed failing before the module exists, including the no-progress series.
- [ ] 2. Fold the activity read into the existing sidebar poll under the same cancelled/abort guard, with the shorter in-flight interval returning to normal when idle. Verify: test that exactly one timer exists and that the interval changes, and that a model switch drops the previous model's activity (see `models-picker-ux`).
- [ ] 3. Render the activity line, the stalled text and the cache note in `sidebar/context.tsx`; failure outranks activity (D4). Verify: `cd packages/tui && bun run typecheck`; render tests for prefill, decoding, stalled, idle, older host.
- [ ] 4. Gate `return_progress` on the host's capabilities and send it only for streaming requests to a local provider. Verify: test that other providers' request bodies are unchanged.
- [ ] 5. Live check on a real llama-skein host: a large cold request shows prefill percentage and ETA moving, then decoding; freezing the backend shows the stalled text; nothing is cancelled. Record the observed lines.
