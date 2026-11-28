# Spec delta: context-meter (context-meter-threshold)

## ADDED Requirements

### Requirement: The meter shows where compaction happens

The context meter MUST show the compaction threshold when it differs from the configured context, and the number it shows MUST be the number the server uses to decide to compact.

#### Scenario: Threshold below the configured context
- **WHEN** the configured context is 81,920 and the compaction threshold is 65,126
- **THEN** the meter shows both numbers, and the threshold is the one the usage percentage is measured against

#### Scenario: No distinct threshold
- **WHEN** a model's compaction threshold equals its displayed context, as for a cloud provider whose limit came from a catalog
- **THEN** the meter shows a single number, as it does today

#### Scenario: The displayed threshold is the server's threshold
- **WHEN** the server's reserved-token rule changes, including the size of the fit-derived buffer
- **THEN** the meter reflects the change without a second constant in the client having to be edited, or a test fails
