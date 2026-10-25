## ADDED Requirements

### Requirement: local provider capability lives behind the plugin boundary
The Skein local-provider surface SHALL be delivered by plugins (not fork patches from
`src/local/`), with registration verifiable through opencode's own registries.

#### Scenario: registration is verified from the host side
- **WHEN** the plugin is loaded against the pinned opencode release
- **THEN** its tools, commands, RPC methods and TUI routes are read back from the
  host's registries (the P1.2 probe), and a model-invoked tool run is recorded as live
  evidence

### Requirement: placement behavior is regression-tested at the plugin boundary
The §11.4 placement invariants SHALL have regression tests that run through the plugin
packages (model-ID verified in warm-peer routing, idle-sorting fits its policy, reused
sessions keep task context, capacity is never double-counted).

#### Scenario: a placement regression fails, not matches policy
- **WHEN** a regression test is reverted (test deleted or the invariant broken)
- **THEN** the suite goes red — proving the suite actually holds the §11.4 invariants
  rather than paraphrasing them

### Requirement: fork-side disposition of `src/local/` is explicit
The port SHALL record which of `src/local/` remains in the fork tree and why, so the
P1.7 delete-and-verify step works from an inventory and not from assumptions.

#### Scenario: nothing retained by accident
- **WHEN** P1.7 removes fork-side local-provider code
- **THEN** its inventory matches the recorded retained-delta list with no stray paths
