# Tasks: port beads/ to plugin

- [ ] 1.1 Move the beads domain into `skein-beads`; register tools/commands/RPC per the
      plugin flavour chosen per package (R-P5); probe registered via `Host.resolve`.
- [ ] 1.2 Provide interim access to beads surfaces (command/RPC) equivalent to the old
      subcommands until `skein-cli` (P1.8) lands; list any regression the interim path
      cannot carry.
- [ ] 1.3 Re-point existing beads tests; no silent deletion.
- [ ] 1.4 Record disposition of fork-side `beads/` for P1.7.
