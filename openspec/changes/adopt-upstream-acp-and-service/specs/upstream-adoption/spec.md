## ADDED Requirements

### Requirement: verification precedes fork retirement
The fork's remnants (acp/, context/, fork/ and the ported areas) SHALL be reduced only
after upstream demonstrably covers charter §6.4 (ACP compatibility list) and §7.6 (the
ten lifecycle assertions) — each verification row evidenced by a live run.

#### Scenario: an unverified contract blocks deletion
- **WHEN** the §7.6 assertions or the §6.4 external-client leg have not been run
- **THEN** the deletion tasks remain gated and nothing fork-side is reduced

### Requirement: every upstream shortfall is dispositioned, not forked
Any gap §6.4/§7.6 verification exposes SHALL become either a reasoned upstream PR or a
documented gap with an explicit mitigation; creating a new fork to cover a gap is
forbidden (charter §23).

#### Scenario: a lifecycle failure routes to a ledger
- **WHEN** an assertion fails against upstream
- **THEN** the gap ledger holds exactly one disposition for it, with either a PR link
  or a recorded mitigation, traceable from the evidence doc

### Requirement: the swap is real only after the plugin stack is proven
The operator's opencode installation SHALL transition to the upstream-plus-plugins
setup only after the verification chain (tasks 1.1–1.6) passes, with the fork-era state
migration decision recorded first, and the skein-ecosystem `--agent` dependency either
upstream-able or listed as preserved delta.

#### Scenario: no cutover with open verification
- **WHEN** the installer swap is proposed with any verification task open
- **THEN** the swap is refused and the open item surfaced instead
