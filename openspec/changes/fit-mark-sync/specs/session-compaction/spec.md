# Spec delta: session-compaction (fit-mark-sync)

## ADDED Requirements

### Requirement: The fit-derived verdict describes the assigned context number

The verdict that selects the small fit-derived compaction buffer MUST be a claim about the `limit.context` value a discovery pass assigned, not about whether fit data was present.

- When a pass assigns `limit.context` from a fit report's `max_safe_ctx`, the model MUST be marked fit-derived.
- When a pass re-uses a previously-known context value because no fit report was available, the previous verdict MUST be kept — a lost probe must not widen a budget that a report trimmed.
- When a pass assigns a context value from any other source (the backend's raw `context_length`/`max_context_length`, a catalog, or nothing), the model MUST NOT be left marked fit-derived.

#### Scenario: A stale verdict cannot widen the threshold
- **WHEN** a model was marked fit-derived in an earlier pass with `max_safe_ctx` 67,174, and a later pass in a fresh provider state has no fit report and no retained value, so it adopts a raw `context_length` of 81,920
- **THEN** the model is no longer marked fit-derived
- **AND** the compaction threshold is 73,728 (`81,920 − min(20,000, 8,192)`), not 79,872

#### Scenario: A lost probe keeps a trimmed budget trimmed
- **WHEN** a fit-derived model with `limit.context` 67,174 is re-discovered with no fit report while 67,174 is the previously-known value and the backend reports a larger raw `context_length`
- **THEN** the conservative branch keeps 67,174 and the fit-derived verdict is kept
- **AND** the threshold stays 65,126

#### Scenario: A fit report still wins
- **WHEN** a pass has a fit report with `max_safe_ctx` 67,174
- **THEN** `limit.context` is 67,174, the verdict is fit-derived, and the threshold is 65,126
