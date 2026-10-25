# Tasks: port peer/ to plugin with durable delegation

Depends on `plugin-repo-layout` (isolation proof) for the ledger design; do not invent
a second delegation mechanism.

- [ ] 1.1 Port peer registry and message envelope into `skein-peer`; tools via the
      `tool` domain; keep session identity + verified-authority checks intact.
- [ ] 1.2 Port `peer/claude/` sidecar; absorb the `sidecar-orphan-cleanup`-era orphan
      rules as plugin-owned lifecycle; kill-test orphaning on plugin reload.
- [ ] 1.3 Replace the in-memory pending-reply registry: durable correlation record
      (task ID, correlation ID, deadline, attempt count, committed outcome), written in
      design.md and exercised with a crash-mid-round-trip test.
- [ ] 1.4 Delivery semantics: at-least-once with dedup on replay; a repeated delivery of
      the same task commits exactly one outcome (tests both directions).
- [ ] 1.5 Re-point existing peer tests; adding durable semantics does not change
      observed behavior for happy-path conversations (envelope unchanged).
- [ ] 1.6 Record the ledger's storage choice + crash-consistency argument in design.md;
      cite the P1.1 isolation evidence.
- [ ] 1.7 Disposition of fork-side `peer/` recorded for P1.7.
