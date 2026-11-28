## Why

The context meter and the compaction threshold disagree, and nothing on screen tells the user where compaction will actually fire.

Measured on one host (2026-11-22), for a 28 GB model configured with `n_ctx` 81,920 and `--n-predict` 8,192:

| Quantity | Tokens |
|---|---|
| Configured context (`n_ctx`), what the meter shows | 81,920 |
| `max_safe_ctx`, the ceiling the host enforces with a 413 | 67,174 |
| Compaction trigger after `local-fit-double-reserve` | 65,126 |

The meter (`packages/tui/src/feature-plugins/sidebar/context.tsx:177`) renders usage against `limit.contextMax ?? limit.context`, so a session reads "46k of 80k" and then compacts at 65,126 with no warning that the number on screen is not the number that matters. `local-model-gallery` and `local-context-truth` already established that the displayed context must be the ceiling the request actually hits; the meter is the remaining place where a decorative number is shown instead of an enforced one.

**Split out of `local-fit-double-reserve` task 5 on 2026-11-28, at the owner's decision**, so the token-saving fix (PR #139) could be reviewed and merged on its own merits. That change fixed the threshold; this one makes the threshold visible.

## Open design question — settle this before writing code

`usable()` and the 2,048-token fit-derived buffer live in `packages/opencode/src/session/overflow.ts`, in the server process. The TUI meter has `limit.context`, `limit.contextMax` and a llama-skein fit poll, but no access to that verdict or that constant. Three candidate sources, not interchangeable:

1. **Server exposes the threshold** on the model or session payload, and the meter renders what it is given. One source of truth; costs an API/SDK surface change.
2. **TUI computes `limit.context − 2_048`** from data it already has, with a test that fails if the TUI constant and `FIT_DERIVED_BUFFER` diverge. Cheap, but the number then exists in two packages and only a test keeps them equal.
3. **Nothing new**: derive the display from the existing `compaction.reserved` config when the user has set it, and show nothing otherwise. Honest but only covers the configured case.

Option 2 is the one that can rot silently — the file loads, the number renders, and it has quietly stopped being the server's number. If it is chosen, the pinning test is not optional.

## What Changes

- The context meter shows the compaction threshold alongside the configured context when the two differ, e.g. "46k of 65k before compaction (80k context)".
- The source of the threshold is decided per the question above and recorded in `tasks.md` when implemented.
- No change to when compaction actually fires — this is display only.

## Impact

- `packages/tui/src/feature-plugins/sidebar/context.tsx` (the sidebar meter), possibly `packages/tui/src/routes/session/subagent-footer.tsx` and `packages/tui/src/component/prompt/index.tsx:396`, which also show a bare token count.
- Possibly `packages/opencode/src/session/overflow.ts` plus the API/SDK if option 1 is chosen.
- Depends on `local-fit-double-reserve` (PR #139) landing first; before that the threshold itself is wrong.
- Related, in llama-skein: the fixed 8% margin inside `max_safe_ctx` (change `tune-prompt-margin`).
