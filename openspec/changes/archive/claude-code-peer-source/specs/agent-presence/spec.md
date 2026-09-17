## ADDED Requirements

### Requirement: presence records carry an owner beyond opencode-skein

The presence model SHALL admit records whose owner is an agent runtime other than
opencode-skein, and every consumer of the roster SHALL render such a record without
special-casing it.

#### Scenario: a Claude Code session appears in the roster

- **WHEN** a Claude Code session is running in a directory on this machine
- **THEN** the roster includes it with owner `claude-code`, its directory, display name
  and status, listed alongside opencode-skein sessions rather than separately

### Requirement: the Claude Code source is read-only and metadata-only

The source SHALL read only Claude Code's session registry — via its CLI, or the registry
files as fallback — and SHALL NOT write any file under Claude Code's state directory, read
any credential material, or read prompts, transcripts or tool output.

#### Scenario: no credential is read

- **WHEN** the source collects peers
- **THEN** no `*.key` file is opened and no peer token is present anywhere in process state

#### Scenario: no content is exposed

- **WHEN** a Claude peer record is serialized
- **THEN** it contains no prompt text, message content or tool output

### Requirement: unknown fields are absent, not invented

Where the source does not publish a field the presence record defines, the record SHALL
omit it rather than substitute a default or inferred value.

#### Scenario: model is unknown

- **WHEN** a Claude peer is mapped to a presence record
- **THEN** `model`, `provider` and `agent` are absent, not empty strings or guesses

### Requirement: a failing source degrades to zero peers

The Claude source SHALL contribute zero peers — and SHALL NOT prevent the roster from
returning opencode-skein peers — when it is unavailable, fails, or returns a shape the
implementation does not recognize.

#### Scenario: the CLI is missing

- **WHEN** the `claude` binary is not installed and no registry directory exists
- **THEN** the roster returns opencode-skein peers normally and reports the Claude source
  as unavailable

#### Scenario: the output shape changed

- **WHEN** the source returns JSON that no longer matches the expected shape
- **THEN** zero Claude peers are contributed and the roster still renders

### Requirement: a dead session is unreachable, not absent

A registry entry whose owning process is no longer alive SHALL be reported as
`unreachable` rather than silently omitted.

#### Scenario: a session's process died

- **WHEN** a registry entry names a pid that does not exist
- **THEN** the peer is listed as `unreachable` with its last observed data

### Requirement: peers resolve to a unit of work where possible

When change topology data is available, each peer SHALL be annotated with the change slug,
tracker issue and branch matched by its working directory, regardless of owner.

#### Scenario: two owners on one change

- **WHEN** a Claude session and an opencode-skein session run in sibling worktrees of the
  same change
- **THEN** both are annotated with that change's slug and issue

#### Scenario: topology is unavailable

- **WHEN** no topology source is installed
- **THEN** peers are listed with directories and without slugs, and no error is surfaced
