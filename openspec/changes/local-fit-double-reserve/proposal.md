## Why

For a llama-skein host, opencode-skein sets a model's context limit from the host's fit report, and then compaction subtracts the reply allowance from it a second time.

- `discoverOpenAICompatibleModels` (`packages/opencode/src/provider/provider.ts`) sets `limit.context = fit.maxSafeCtx`.
- llama-skein computes `max_safe_ctx = 0.92 × n_ctx − output_reserve`, where the output reserve is the model's `--n-predict` (default 4096). So the number already has the reply allowance removed, and the host rejects prompts above it with HTTP 413.
- `usable()` in `packages/opencode/src/session/overflow.ts` then computes `context − reserved`, and `reserved` defaults to `min(20,000, maxOutputTokens(model))`. For a model whose host advertises `max_output_tokens: 8192`, that is a further 8,192 tokens.

The reply allowance is deducted twice. Measured on one host on 2026-11-22, a 28 GB model configured with `n_ctx` 81,920 and `--n-predict` 8,192:

| Quantity | Tokens |
|---|---|
| Configured context (`n_ctx`) | 81,920 |
| `max_safe_ctx` advertised, and enforced by the host (413 above it) | 67,174 |
| Compaction trigger in opencode-skein (`67,174 − 8,192`) | 58,982 |

A session can therefore compact with the host still willing to accept 8,192 more tokens of prompt, which is 12% of the usable window, and with 14,000+ tokens of the physical context still free. For a session that carries a large fixed prompt (system prompt, tool schemas, skills), the headroom after each compaction is small, so compaction repeats often.

A second, smaller effect: the context meter shows usage against the configured context (`contextMax`, 81,920 here), while compaction fires at a lower point. The user sees "46k of 80k" and a compaction well before 80k, with no indication of where the trigger is.

The `compaction.reserved` setting lets a user work around this, but it has to be discovered, and the right value depends on the host.

## What Changes

- Mark a model whose `limit.context` came from a llama-skein fit report (`maxSafeCtx`) as fit-derived, for example with a field on the discovered model.
- For fit-derived models, `usable()` reserves only a small safety buffer (default 2,048 tokens) instead of the model's maximum output tokens, because the reply allowance is already excluded. An explicit `compaction.reserved` still wins.
- Models not derived from a fit report keep today's rule.
- Not in this change: showing the compaction trigger in the context meter (the "second, smaller effect" above). It was split out on 2026-11-28 into `context-meter-threshold`, by owner decision, so the threshold correction could be reviewed alone. The meter still shows only the configured context until that change lands.

## Impact

- `packages/opencode/src/provider/provider.ts` (discovery), `packages/opencode/src/session/overflow.ts` (`usable`).
- No change for non-llama-skein providers. The meter in the TUI is untouched here.
- Related, in llama-skein: the 8% margin inside `max_safe_ctx` is fixed (change `tune-prompt-margin`).
