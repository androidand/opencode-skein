## Why

A local model can finish its answer and then never emit a stop token, streaming
the same few characters forever (observed: `</parameter></invoke>` x636 after
`<promise>COMPLETE</promise>`, 127 s, until the user aborted). Nothing in the
harness bounds this: text-delta only appends, loop-detect compares *completed*
turns, the chunk timeout never fires because tokens keep arriving, and the only
cap is 32,000 output tokens (~8 min at 65 tok/s). 26 build turns and 8
compactions on kat-coder alone hit that cap. A runaway *compaction* is worse: the
junk is accepted as the summary (`finish=length` counts as completed) and refills
the next context.

## What Changes

- Detect a runaway inside a single stream (a short unit repeated at the tail) and
  cut it: stored text is trimmed to the first instance, the stream is closed.
- Recovery ladder per session: (1) synthetic nudge "get a hold of yourself",
  (2) if it runs away again, compaction-based reset of the history (runaway text
  already excluded) followed by the auto-continue prompt, (3) stop with an error.
  A turn that completes normally resets the ladder.
- A compaction that runs away or ends `finish=length` is not a summary: it is
  retried with the minimal history, then replaced by the minimal summary.
- Sentence-level loops (the 21 Oct `stream-loop` WIP: a short sentence, or an
  alternating pair, repeated a few times) are cut through the same path.
- Spec-queue briefs cap the inlined documents (unrelated fix carried from the
  same working tree).
- Overflow-compaction breaker (from the shared tree): stop after 2 consecutive
  overflow compactions with no completed turn.

## Impact

`session/processor.ts`, `session/prompt.ts`, `session/compaction.ts`, new
`session/runaway-detect.ts`. No config, API or schema change.
