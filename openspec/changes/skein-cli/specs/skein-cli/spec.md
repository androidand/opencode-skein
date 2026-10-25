## ADDED Requirements

### Requirement: the platform is diagnosable without the dashboard
The `skein` CLI SHALL expose the charter §17 command set (`status`, `projects`,
`agents`, `work ready|running|blocked`, `fleet`, `trace <execution-id>`, `doctor`) over
the plugin RPC and opencode server API, replacing the legacy subcommands.

#### Scenario: every command answers against real state
- **WHEN** each command is run against a live plugin stack
- **THEN** it renders actual platform state, and unknown verbs fail with usage rather
  than guessing

### Requirement: missing observability is reported, never fabricated
The CLI SHALL state the absence of correlation IDs that `skein trace` would show (before
`skein-observability` lands) instead of rendering them as if present.

#### Scenario: trace with no IDs says so
- **WHEN** `skein trace <execution-id>` runs before observability exists
- **THEN** it reports the missing ID classes rather than rendering an empty-looking
  success

### Requirement: doctor proves the checks that would matter
`skein doctor` SHALL include the plugin health probes (resolution, duplicate IDs,
exactly-one-`effect`) and the planning-copy freshness check so the CI gates from
`plugin-repo-layout` are visible to a human locally.

#### Scenario: doctor catches a dirty pin
- **WHEN** a second `effect` enters the dependency tree locally
- **THEN** `skein doctor` fails with the offending package, matching the CI gate
