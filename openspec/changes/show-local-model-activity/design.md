# Design: show-local-model-activity

## D1. Reuse the sidebar poll, never add a loop

The sidebar already polls hardware, tuning and fit under one cancelled-flag/abort
guard, keyed so that stream ticks do not restart it. Activity is read inside that
same poll. While a request is in flight the poll interval shortens (to about 2 s) and
returns to its normal interval when idle. A second timer would reintroduce the
stale-poll bugs `models-picker-ux` documents.

## D2. Prefer the stream for the request being waited on

For the request the user is staring at, the stream is the freshest source, and
`return_progress` costs nothing extra. For everything else (another client's
request, a request that has not yet produced a chunk) the host's `/api/activity` is
the source. When both exist the stream wins for the current request; the host record
fills the rest. They are never summed.

## D3. `stalled` is the host's word

opencode does not derive "stalled" from its own timers. A client that sees no bytes
for a minute cannot tell a hang from a long prefill; the host can, because it sees
the counts. If the host does not say, the line shows the last known phase and counts
and the age of the last change, and no verdict.

## D4. A single row, shared

The sidebar row is shared with the failure display from `model-launch-settings-surface`.
Failure outranks activity: a failed launch hides the activity line.

## Open Questions

- Is `return_progress` safe to send to every llama-skein backend in the fleet, or
  must it be gated on the host's capabilities? Default to gating until checked.
- What interval is acceptable on a metered or remote link? Default 2 s in flight.
