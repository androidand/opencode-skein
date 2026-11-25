## Detector

`findRunaway(text)` looks at the tail: for each period p in 1..256 it measures
how far the text is p-periodic backwards from the end. It fires when the periodic
span is >= 400 chars AND >= 20 repeats of a unit that is not whitespace. Returns
`keep` = the text length to retain (end of the first instance of the unit).
Thresholds keep an 80-char `-----` rule and ordinary tables from firing. Cost is
one mismatch compare per period per delta in the common case.

## Processor

Text deltas are checked after append. On a hit the part is trimmed to `keep`, the
context records the runaway, and the stream is closed through the existing
`Stream.takeUntil` (same mechanism as `needsCompaction`). `process` returns the
new result `"runaway"`; the message finish is `"length"`-like but explicit:
`runaway`. Reasoning deltas are not checked in this change.

## Ladder (prompt.ts, state in compaction.ts beside the loop-break state)

1st runaway: nudge. 2nd with no clean turn between: `compaction.create({auto:true})`
— the existing auto-continue message is the "go on". 3rd: terminal error. Any turn
that finishes without runaway clears the count.

## Compaction

`runaway` or `finish=length` is treated like overflow in the existing self-healing
path: the failed attempt gets an error (so it is not a completed compaction), retry
on minimal history, else minimal summary with the junk text parts removed.
