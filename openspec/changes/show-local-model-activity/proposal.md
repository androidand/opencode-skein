# Show what a local model is doing while it is quiet

> **Labels.** This repo is public, so hosts and models are named by capability and
> shape. Host A is a 32 GB RDNA4 workstation serving a 27B hybrid-attention model
> (`M1`) through llama-skein. The mapping lives in the private companion repo.

## Why

A session on `M1` produced no output for minutes while Host A's GPU read 100% busy.
The sidebar showed the same t/s, context bar and VRAM bar it shows when everything
is fine. The operator could not tell:

- a long prefill (the request carried 118,784 prompt tokens, none of them cached
  after a server reload), from
- slow decoding at a nearly full context (a later request decoded at about 18
  tokens per second), from
- a hang.

All three look identical, so the natural reaction was to interrupt, which throws
away the prefill and makes the retry pay it again. The truth was recoverable only by
SSHing to the host and polling the backend's slots by hand. opencode already polls
the host for fit and hardware on the sidebar's existing loop; it just has nothing to
read activity from, and llama-skein is gaining that
(`add-model-activity-reporting`).

## What Changes

- **A live activity line in the sidebar** for a local model with a request in
  flight: `prefill 63%  75k/118k  ~40 s`, `decoding  18 t/s`, or
  `no progress for 90 s`. Nothing is shown when idle, so a healthy quiet session
  looks as it does today.
- **A stalled warning that never acts.** When the host reports `stalled`, the line
  says so and what is known (the last phase and counts), and offers nothing
  destructive. Interrupting stays the user's decision, now an informed one.
- **Cache visibility.** When the host reports a cached prefix, show how many tokens
  were reused, so a user can see why one turn was instant and another took minutes
  (a server reload or model swap empties the cache).
- **Two sources, one display.** Primary: the host's `/api/activity` (or the
  `activity` events), folded into the existing sidebar hardware/fit poll and its
  abort and cancelled guard, with no new loop. In-band: for streaming requests to a
  local provider opencode may send `return_progress: true` so the prefill of the
  request being waited on updates from the stream itself.
- **Degrades silently.** Against a host without activity reporting, no line is
  shown and nothing errors.

## Capabilities

### New Capabilities

- `local-model-activity-display`: the sidebar activity line, stalled warning, cache
  note, and the two sources.

## Where this lives

A change to the existing sidebar feature plugin
(`packages/tui/src/feature-plugins/sidebar/context.tsx`), on top of its current poll
(`per-model-placement-controls` task 2 already folded `/api/fit` into it). No core
change. See `design.md`.

## Non-goals

- No action on `stalled`: no interrupt, retry or unload is automated or suggested as
  the default.
- No breakdown of what fills the context window (system prompt, skills, tools,
  conversation). That is a separate, related question and should be its own change.
- No change for non-llama-skein providers.

## Related

- llama-skein (private companion): `add-model-activity-reporting`.
- `models-picker-ux` — the sidebar poll key widening it describes is a prerequisite
  for showing the right model's activity after a switch.
- `per-model-placement-controls` — shares the sidebar poll and its guard.
- `model-launch-settings-surface` — the failure display there and the activity line
  here must not both claim the same sidebar row.
