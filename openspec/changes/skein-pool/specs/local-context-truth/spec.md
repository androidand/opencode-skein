# Local context truth stays fresh

## ADDED Requirements

### Requirement: A host's live per-slot context ceiling updates the cached limit without a full reload

A local provider's cached `model.limit.context` SHALL reflect the authoritative
`max_safe_ctx` that the host currently advertises, not only the value captured at
discovery or on a prompt overflow. llama-skein computes `max_safe_ctx` from
`hard_ctx / --parallel` (fit.go), so an operator raising `--parallel` on a running
host shrinks the per-request ceiling without reloading the model, and opencode must
adopt the smaller figure rather than keep using the stale, too-large one.

The cached limit SHALL be updated from a fresh `/api/fit` probe when one is available,
writing only the context ceiling (the hard `n_ctx`/ceiling is left untouched). The
existing prompt-overflow recovery (`adjustLocalContextOnOverflow`) is one such probe;
the pool adds another at placement time.

#### Scenario: Host raises --parallel mid-session

- **WHEN** a local host was discovered at `--parallel = 1` with `max_safe_ctx = 100000`
  and the operator later raises `--parallel` so the host advertises `max_safe_ctx = 25000`
- **THEN** opencode's cached `limit.context` is updated to the fresh `25000` on the next
  re-probe, so placement and prompt trimming use the correct smaller budget

#### Scenario: Stale limit is used until the next re-probe

- **WHEN** a prompt that is oversized for the *new* ceiling is sent while the cached
  `limit.context` still holds the old, larger value
- **THEN** the request 413s with `prompt_over_max_safe_ctx`, the recovery re-probes
  `/api/fit`, and the cached limit is corrected to the fresh ceiling so the next turn
  compacts against the right budget instead of repeating the same oversized request

### Requirement: pick returns the chosen model's fresh context ceiling

`LocalPlacement.pick` SHALL return the chosen model's fresh `maxSafeCtx`, and
`task.ts` SHALL write it through `Provider.setModelContextLimit(..., "keep")` — the
context ceiling only, leaving the configured hard `n_ctx` untouched — so a freshly
placed local sub-agent is told the host's current per-request budget, not a stale one.

#### Scenario: A newly placed local sub-agent gets the current ceiling

- **WHEN** `pick` selects a local host whose `/api/fit` now advertises a smaller
  `max_safe_ctx` than the cached limit
- **THEN** the returned ceiling is the fresh value and `task.ts` writes it through, so
  the sub-agent's prompts are trimmed against the correct budget from the first turn

#### Scenario: Hard n_ctx is preserved

- **WHEN** the context ceiling is written through on placement
- **THEN** only `limit.context` changes; the configured hard `n_ctx` (and any ceiling
  that was intentionally set higher) is left as it was
