# Fix: loops die on peer messages and leak change claims

## Why

A peer message delivered to a running loop is stored as a user message with
`agent: crew-inbox` and `model: none/none`. The next prompt step takes the
newest user message to pick the model, fails with `Model not found: none/none`,
and the loop fiber dies without any visible output.

Reviewing the claim lifecycle found a second defect: a loop that is cancelled,
errors or is killed mid-change never releases its claim, and the queue treats
every unreleased claim as live. That change is then skipped forever.

## What Changes

- The inbox message carries the agent, model and turn settings of the session's
  latest user message.
- A queue run keeps its claim's heartbeat fresh while it holds it and releases
  it when the run ends for any reason.
- A claim with a stale heartbeat no longer blocks the queue and can be taken
  over.
- A loop that dies records the cause in its report.
