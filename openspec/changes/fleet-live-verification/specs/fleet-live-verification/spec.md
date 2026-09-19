## ADDED Requirements

### Requirement: fleet capacity truth is observable

A live fleet session SHALL observe, via `peers` and `opencode agents`, that a host
serving a request reports `0/1 slots free` and an idle host reports `1/1 slots free`. A
delegated subagent SHALL land on a host that shows available capacity.

#### Scenario: a busy host and an idle host show opposite capacity

- **WHEN** one host is serving a request and another host is idle
- **THEN** `peers`/`opencode agents` show the busy host `0/1 slots free` and the idle host `1/1`

#### Scenario: a subagent lands on an idle host

- **WHEN** a subagent is delegated from a full host
- **THEN** it is placed on a host that reported available capacity (`1/1 slots free` or `idle`)

### Requirement: background fan-out does not block

A local orchestrator fanning out three tasks SHALL NOT block on the first task. All three
tasks SHALL land on different hosts or peers.

#### Scenario: three tasks fan out in parallel

- **WHEN** a local orchestrator delegates three independent tasks
- **THEN** all three land on different hosts or peers without serializing on the first

### Requirement: cloud parent places a local subagent on a local host

A role with `placement: "local"` run from a cloud model SHALL place its subagent on a local
host rather than a cloud host.

#### Scenario: a local-placement role run from the cloud

- **WHEN** a role with `placement: "local"` is run from a cloud model
- **THEN** its subagent is placed on a local host

### Requirement: context-aware placement skips small-ctx hosts

A subagent prompt larger than a small-ctx host's `max_safe_ctx` SHALL skip that host. The
placed model's `limit.context` SHALL equal the host's current `max_safe_ctx`.

#### Scenario: a large prompt skips a small-ctx host

- **WHEN** a subagent prompt exceeds a host's `max_safe_ctx`
- **THEN** that host is skipped and a host with sufficient context is used

### Requirement: delegation to a peer completes the task

A parent on a full single-slot host with an idle peer SHALL deliver the task envelope to the
peer. The peer's `[peer-task-result]` reply SHALL land as the task result. This SHALL work
with an idle Claude Code peer and with an idle opencode peer on a cloud model.

#### Scenario: delegation to an idle Claude Code peer

- **WHEN** a parent on a full single-slot host delegates to an idle Claude Code peer
- **THEN** the task envelope arrives at the peer and its `[peer-task-result]` reply lands as the task result

#### Scenario: delegation to an idle opencode peer on a cloud model

- **WHEN** a parent delegates to an idle opencode peer running on a cloud model
- **THEN** the task envelope arrives at the peer and its reply lands as the task result

### Requirement: an eternal loop runs until stopped

A plain `/loop` on a quickly-completing prompt SHALL keep going until stopped. A loop started
with `--until-done` SHALL stop on completion.

#### Scenario: plain /loop keeps running

- **WHEN** a plain `/loop` is started on a quickly-completing prompt
- **THEN** it keeps iterating until the user stops it

#### Scenario: --until-done stops on completion

- **WHEN** a loop is started with `--until-done` on a quickly-completing prompt
- **THEN** it stops once the prompt completes

### Requirement: persona fan-out shows parts inline

A `/backlog` on a real change SHALL show the reviewer persona's parts inline.

#### Scenario: reviewer persona parts appear in backlog

- **WHEN** `/backlog` is run on a real change with a reviewer persona
- **THEN** the reviewer persona's parts are shown inline
