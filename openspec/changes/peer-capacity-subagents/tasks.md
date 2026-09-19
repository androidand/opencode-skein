# Tasks: borrow a peer's capacity as a subagent

## Phase 0: Find out why the existing path is unused

- [ ] 0.1 Instrument the placement decision: log the chosen option and the
      rejected candidates with their scores, at every `task` call that runs
      placement. No behaviour change.
- [ ] 0.2 Run a normal day's work and read the log. Establish which of the
      three suspected causes actually dominates: narrow trigger, empty roster,
      or free-slot-but-owned. Record it in findings.md.
- [ ] 0.3 Only then decide how much of Phase 2 is needed. If the roster fix
      alone restored delegation, most of it is unnecessary.

## Phase 1: Host a subagent without polluting the host

- [ ] 1.1 Add a hosted-subagent request to the peer transport, carrying caller
      identity, task description, deadline and correlation id.
- [ ] 1.2 On receipt, create a child session with the host's provider/model and
      an empty history; run the task there under the HOST's permissions.
- [ ] 1.3 Return the result through the existing correlation header; the host's
      own session records one line, never the task text.
- [ ] 1.4 Allow refusal, and make it a normal answer the caller handles.
- [ ] 1.5 Tests: host session's transcript is unpolluted; child inherits the
      host's model and permissions, not the caller's; refusal is handled;
      deadline miss reports to the caller.

## Phase 2: Rank capacity honestly

- [ ] 2.1 Join sessions to hosts in placement, reusing the signal `describeFleet`
      already computes, and rank per design.md.
- [ ] 2.2 Widen the trigger beyond `"no-slot"`; make a failed probe rank below a
      visible peer rather than falling through to inherit.
- [ ] 2.3 Tests over a fixture fleet for each rank position, including the
      swap-forcing case being last.

## Phase 3: Verification

- [ ] 3.1 Live: saturate the local fleet, confirm work goes to an idle peer and
      that the peer's own transcript stays clean.
- [ ] 3.2 Live: confirm a refusing host is skipped without an error surfacing to
      the model.
- [ ] 3.3 Measure whether agents actually use it, from the Phase 0 log. If the
      answer is still no, the shape is still wrong and the change has failed —
      say so rather than shipping it.
