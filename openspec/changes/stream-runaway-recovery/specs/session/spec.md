## ADDED Requirements

### Requirement: Runaway streams are cut
A text stream whose tail repeats a short unit at least 20 times over at least 400 characters SHALL be closed and its stored text trimmed to the first instance.

#### Scenario: invoke spam after a finished answer
- **WHEN** the model emits `</parameter>\n</invoke>\n` 600 times after its answer
- **THEN** the stream is closed, the stored text ends after one instance, and the turn result is `runaway`

#### Scenario: ordinary repetition is left alone
- **WHEN** the text contains an 80-character `-` rule or a markdown table
- **THEN** nothing is cut

### Requirement: Recovery ladder
After a runaway the session SHALL nudge, then reset by compaction, then stop; a clean turn resets the ladder.

#### Scenario: second consecutive runaway
- **WHEN** a turn runs away after a nudge with no clean turn in between
- **THEN** an automatic compaction runs and the auto-continue prompt follows it

#### Scenario: third consecutive runaway
- **WHEN** a turn runs away after the compaction reset
- **THEN** the run stops with an error and no further automatic recovery happens

### Requirement: Runaway compaction is not a summary
A compaction ending `runaway` or `length` SHALL NOT count as a completed compaction.

#### Scenario: compaction runs away
- **WHEN** the compaction attempt and its retry both run away
- **THEN** both carry an error and a minimal summary message becomes the only completed compaction
