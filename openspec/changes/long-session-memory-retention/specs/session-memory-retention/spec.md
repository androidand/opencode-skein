## ADDED Requirements

### Requirement: old transcript messages collapse past the recent window

A session transcript SHALL render messages older than the most recent `transcript_window`
(default 40) as a one-line collapsed placeholder until the user expands it. The placeholder
SHALL show a one-line summary of the message and a "click to expand" indicator. Because the
rendering uses a conditional match, the losing branch is disposed when a message collapses,
unmounting its heavy renderers rather than hiding them.

#### Scenario: old messages collapse

- **WHEN** a session has more messages than `transcript_window`
- **THEN** messages older than the most recent `transcript_window` render as collapsed one-line placeholders with a "click to expand" indicator

#### Scenario: an expanded message stays open

- **WHEN** a user expands a collapsed message
- **THEN** it stays expanded for the rest of the session

#### Scenario: prompt navigation still lands on prompts

- **WHEN** the user navigates prompts via keyboard
- **THEN** collapsed placeholders carry the message id so navigation still lands on user prompts

### Requirement: SSE subscriber queue is bounded

A subscriber event queue SHALL be bounded to a finite capacity (10,000) using the dropping
queue pattern. On overflow the stream fails and the client reconnects and resyncs.

#### Scenario: an overflowing queue recovers

- **WHEN** an SSE subscriber queue overflows
- **THEN** the stream fails and the client reconnects and resyncs rather than retaining every event forever

### Requirement: part updates use a shallow copy

A part update SHALL copy the part shallowly (`{ ...part }`) rather than `structuredClone`-ing
its bytes on every text publish.

#### Scenario: part snapshots are still correct

- **WHEN** a text part is updated in place
- **THEN** consumers receive a correct snapshot because strings are immutable and destructured synchronously

### Requirement: reasoning header is static while open

The reasoning header SHALL be static while the reasoning body is expanded, with the spinner
showing only while the reasoning is collapsed.

#### Scenario: expanded reasoning does not shake

- **WHEN** a reasoning block is expanded and streaming
- **THEN** the header stays static and only the spinner animates
