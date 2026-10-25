## ADDED Requirements

### Requirement: plugin churn is governed at one repo boundary
The Skein plugins SHALL live in one repository as one plugin per package, with one
lockfile pinning `effect` to the exact version of the pinned opencode release, so an
upstream bump is one coordinated pin change.

#### Scenario: pin bump is one-place
- **WHEN** a new opencode release requires a new `effect` pin
- **THEN** changing it in the single workspace updates every plugin package without
  editing per-repo pins

### Requirement: plugin loading windows are observed, not silent
The build SHALL verify that every declared plugin resolves and registers (tools,
commands, RPC, TUI route as configured) and that exactly one `effect` version exists in
the dependency tree; misshaped or duplicate plugins SHALL fail the build rather than
load silently or report nothing.

#### Scenario: unresolvable plugin fails CI
- **WHEN** a plugin's root entrypoints are missing or misshaped
- **THEN** the `Host.resolve` probe fails the build with the offending path, instead of
  a silent drop (P1.2 trap 3)

#### Scenario: second effect copy fails CI
- **WHEN** a dependency brings a second `effect` version into the tree
- **THEN** the exactly-one-`effect` gate fails before any runtime test runs (trap 1)

### Requirement: host crash isolation is established before TUI ports
The plugin supervisor's behavior under a crashing plugin SHALL be tested deliberately
(load crash, tool-call crash, route-render crash), and the repo layout decision SHALL
cite the measured result — never assume isolation.

#### Scenario: crashing plugin leaves the host standing
- **WHEN** each of the three crash forms is driven against pinned v2.1.3
- **THEN** the result is recorded as evidence, and the layout either rests on
  confirmed isolation or amends per the documented fallback
