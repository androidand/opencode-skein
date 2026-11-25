# Model Launch Settings Surface

## ADDED Requirements

### Requirement: Launch settings are shown and editable per model

For a local model on a host that supports launch settings, the per-model dialog SHALL show a Launch section with the chat template file, thinking mode, sampling defaults and output limit, and SHALL allow editing them.

#### Scenario: Open the section

- **WHEN** the user opens the per-model dialog for a local model on a supporting host
- **THEN** the Launch section lists the current values read from the host

#### Scenario: Unsupported host

- **WHEN** the host does not report launch-settings support
- **THEN** no Launch section is shown and no error is displayed

### Requirement: Edits are previewed before they are applied

Every edit SHALL first show the host's dry-run result (the resulting command and all warnings) and SHALL apply only after an explicit confirmation that names the reload cost.

#### Scenario: Preview with a warning

- **WHEN** the user sets a repeat penalty above the host's bound on a tool-capable model
- **THEN** the preview shows the resulting command and the host's warning, and the change is not yet applied

#### Scenario: Cancel

- **WHEN** the user cancels at the preview
- **THEN** nothing is written and no reload occurs

#### Scenario: Host cannot preview

- **WHEN** the host does not support dry runs
- **THEN** editing is disabled and the section is read-only

### Requirement: A failing launch is explained and recoverable

When the host reports that a model's launch has failed, opencode SHALL show the host's reason and, when the host supplies `suggested_rollback_ref`, SHALL offer a rollback that requires explicit confirmation and SHALL NOT perform it automatically.

#### Scenario: Failure with a suggestion

- **WHEN** the host reports a failed launch with reason `invalid argument: --bogus` and a `suggested_rollback_ref`
- **THEN** the dialog shows that reason and a "Revert to the previous config" action whose confirmation lists the snapshot's summary and the reload cost, with Cancel focused

#### Scenario: No suggestion

- **WHEN** the host reports a failed launch without `suggested_rollback_ref`
- **THEN** the reason is shown and no rollback action is offered

### Requirement: The CLI performs the same operations with the same previews

`opencode models config <provider/model>` SHALL support `--show`, `--set key=value`, `--unset key`, `--dry-run`, `--history`, `--rollback <ref>` and `--json`, and SHALL produce the same preview and warnings as the dialog.

#### Scenario: Dry run

- **WHEN** a user runs `opencode models config p/m --set sampling.temp=0.6 --dry-run`
- **THEN** it prints the resulting command and warnings, writes nothing, and exits 0

#### Scenario: Rollback needs confirmation

- **WHEN** a user runs `opencode models config p/m --rollback <ref>` without `--yes`
- **THEN** it prints the snapshot summary and the reload cost and asks for confirmation before acting

#### Scenario: Machine output

- **WHEN** `--json` is given
- **THEN** output is a single JSON document containing the values, the preview and the warnings
