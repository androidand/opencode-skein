# Tasks: skein CLI

- [ ] 1.1 Record the language + transport decision in design.md (recommendation: Go;
      transport: opencode server API + plugin RPC with explicit location handling
      per the P1.2 traps 5/7).
- [ ] 1.2 Implement `skein status`, `skein projects`, `skein agents` and the `skein
      work ready|running|blocked` triple over server/plugin state.
- [ ] 1.3 Implement `skein fleet` (runtime + inference slots via llama-skein read API)
      and `skein trace <execution-id>` (rendering available IDs; explicit about what is
      absent).
- [ ] 1.4 Implement `skein doctor`: plugin health probes (resolution, duplicate IDs,
      exactly-one-effect), `opencode service` liveness, and the K15 planning-copy
      freshness check.
- [ ] 1.5 Retire the fork-subcommand interim parity from `port-beads-plugin` with
      equivalence evidence (same records read/written).
- [ ] 1.6 Charter §17 conformance: each command has a smoke test; unknown verbs fail
      with usage, never a silent fix.
