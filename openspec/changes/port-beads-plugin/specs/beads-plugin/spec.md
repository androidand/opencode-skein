## ADDED Requirements

### Requirement: beads capability is plugin-delivered with interim parity
The beads surface SHALL be delivered by the `skein-beads` plugin, and until the
`skein` CLI replaces the legacy subcommands, equivalent command/RPC access SHALL exist
without a fork-internal path.

#### Scenario: canary equivalence holds
- **WHEN** the plugin package replaces the fork-native beads reachable behavior
- **THEN** the re-pointed tests pass and any behavioral difference is recorded (none
  silently)

### Requirement: port completion validates the plugin pattern holds
P1.6's completion SHALL note whether the wiring pattern from P1.3–P1.5 generalizes;
any discovered coupling feeds `adopt-upstream-acp-and-service`'s residue inventory.

#### Scenario: residue inventory is complete
- **WHEN** P1.7 plans what to delete from `acp/` `context/` `fork/` and the ports
- **THEN** the beads disposition is present in the recorded inventory
