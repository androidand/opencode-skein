# Local Model Activity Display

## ADDED Requirements

### Requirement: Activity is shown while a local request is in flight

When a local model has a request in flight and the host reports activity, the sidebar SHALL show the phase with its counts and rate, and SHALL show nothing when the model is idle.

#### Scenario: Prefill

- **WHEN** the host reports `phase: prefill` with 75,000 of 118,000 prompt tokens processed and a known rate
- **THEN** the sidebar shows the percentage, both counts and an estimated time remaining

#### Scenario: Decoding

- **WHEN** the host reports `phase: decoding`
- **THEN** the sidebar shows the decode rate

#### Scenario: Idle

- **WHEN** no request is in flight
- **THEN** no activity line is shown

### Requirement: A stalled report is shown and never acted on

When the host reports `stalled`, the sidebar SHALL say that no progress has been seen and for how long, and SHALL NOT interrupt, retry or unload anything.

#### Scenario: Stalled

- **WHEN** the host reports `stalled: true` with 90 seconds since last progress
- **THEN** the line reads that there has been no progress for 90 seconds, with the last phase and counts, and no request is cancelled

#### Scenario: Host gives no verdict

- **WHEN** the host reports counts but no `stalled` field
- **THEN** the line shows the counts and the age of the last change and does not claim a stall

### Requirement: Cached prefix is visible

When the host reports cached prompt tokens, the display SHALL show how many tokens were reused.

#### Scenario: Warm cache

- **WHEN** a request reuses 119,000 cached tokens and processes 800 new ones
- **THEN** the display shows the reused count alongside the processed count

### Requirement: Absence degrades silently

Against a host without activity reporting, no activity line SHALL be shown and no error SHALL be surfaced.

#### Scenario: Older host

- **WHEN** the host has no activity endpoint
- **THEN** the sidebar is unchanged from today
