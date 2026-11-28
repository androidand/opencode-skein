# Spec delta: session-compaction (local-fit-double-reserve)

## ADDED Requirements

### Requirement: The reply allowance is deducted once

The compaction threshold MUST NOT deduct the reply allowance from a context limit that already excludes it.

- When a model's `limit.context` was taken from a llama-skein fit report's `max_safe_ctx`, the threshold MUST reserve only a small safety buffer, not the model's maximum output tokens.
- An explicit `compaction.reserved` setting MUST take precedence.
- A model whose limit did not come from a fit report MUST keep the existing rule.

#### Scenario: Fit-derived model reserves only a buffer
- **WHEN** a fit-derived model has `limit.context` 67,174 and `limit.output` 8,192
- **THEN** the compaction threshold is 65,126, not 58,982

#### Scenario: Explicit setting wins
- **WHEN** `compaction.reserved` is set to 4,096 for the same model
- **THEN** the compaction threshold is 63,078

#### Scenario: Other providers are unchanged
- **WHEN** a model has a context limit from a catalog and no fit report
- **THEN** the threshold is computed as before

The meter requirement was moved out of this change on 2026-11-28 to `context-meter-threshold`, at the owner's decision, so this change ships the threshold correction alone. It is not dropped: see `openspec/changes/context-meter-threshold/specs/context-meter/spec.md`.
