# Tasks: fleet-live-verification

- [ ] 1. Capacity truth (`provider-capacity-truth` 3.1): with one host serving a request,
      `peers`/`opencode agents` show it `0/1 slots free` and an idle host `1/1`; a subagent
      lands on the idle one
- [ ] 2. Background default (`subagent-background-default` 6): a local orchestrator fanning
      out three tasks does not block on the first; all three land on different hosts or peers
- [ ] 3. Cloud parent → local subagent (`role-placement-policy` 4.2): a role with
      `placement: "local"` run from a cloud model places its subagent on a local host
- [ ] 4. Context-aware placement (`ctx-aware-subagent-placement` 10–12): a subagent prompt
      larger than a small-ctx host's `max_safe_ctx` skips that host; the placed model's
      `limit.context` equals the host's current `max_safe_ctx`
- [ ] 5. Delegation (`skein-pool` 2.5): parent on a full single-slot host + idle Claude Code
      peer → task envelope arrives at the peer, its `[peer-task-result]` reply lands as the
      task result; repeat with an idle opencode peer on a cloud model
- [ ] 6. Eternal loop (`loop-eternal-by-default` 6.2): plain `/loop` on a quickly-completing
      prompt keeps going until stopped; `--until-done` stops on completion
- [ ] 7. Persona fan-out (`persona-gate-fanout` 4.5): `/backlog` on a real change shows the
      reviewer persona's parts inline
