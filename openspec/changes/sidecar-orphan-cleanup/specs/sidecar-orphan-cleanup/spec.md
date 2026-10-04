## ADDED Requirements

### Requirement: a sidecar cannot outlive the session that spawned it
A sidecar SHALL terminate within a bounded interval of its owning session's process exiting,
including when the session's process exits before the sidecar has finished starting.

#### Scenario: parent exits during sidecar startup
- **WHEN** the spawning process exits before the sidecar process has begun executing
- **THEN** the sidecar terminates within a bounded interval rather than running indefinitely

#### Scenario: parent exits after the sidecar is established
- **WHEN** the spawning process exits without signalling, after the sidecar is running
- **THEN** the sidecar self-terminates and removes its own registration

#### Scenario: reparenting is not evidence of orphaning on its own
- **WHEN** a sidecar is started by an intermediate process that has already exited
- **THEN** the sidecar SHALL determine liveness from its owning session, not from a single
  reading of the parent pid taken at startup

### Requirement: every live sidecar is discoverable and reclaimable
A sidecar that is running SHALL either be attributable to a live session, or be reclaimable by
an explicit operator action. A running sidecar SHALL NOT exist that is neither.

#### Scenario: orphan with a stale registration
- **WHEN** a sidecar is running, its registration is present, and the owning session's process
  is gone
- **THEN** an operator command can identify and terminate it

#### Scenario: orphan with no registration
- **WHEN** a sidecar is running and no registration exists for it
- **THEN** an operator command can still identify it as a candidate, and the condition is
  reported rather than silently tolerated

### Requirement: registration is established before or with the process
A sidecar's ownership SHALL be recorded such that a running sidecar is never simultaneously
unregistered and unreclaimable.

#### Scenario: session exits between spawn and registration
- **WHEN** the session's process exits between spawning a sidecar and writing its registration
- **THEN** the resulting sidecar is still reclaimable by an operator command

## MODIFIED Requirements

### Requirement: the boot sweep removes stale registrations without signalling processes
The startup sweep SHALL continue to remove registration files whose process is no longer alive,
and SHALL NOT signal any running process. Reclaiming a live process is a separate, explicit
operator action.

#### Scenario: registration whose process has exited
- **WHEN** the sweep finds a registration whose pid is not alive
- **THEN** it removes the registration file and its key file

#### Scenario: registration whose process is alive
- **WHEN** the sweep finds a registration whose pid is alive
- **THEN** it leaves the registration untouched, regardless of whether the owning session
  appears inactive

## Non-goals

These requirements cover process lifetime and cleanup only. Sender identity, lead grants and
the review record are unchanged here; `review-on-done` tracks identity separately, and its
Phase 1b depends on the decision recorded in
`openspec/changes/review-on-done/findings-authenticity.md`.