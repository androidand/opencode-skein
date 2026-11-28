## ADDED Requirements

### Requirement: Accepted divergence is a pinned content claim, not a path exemption
An entry in `fork/manifest.json` `divergence.accepted` SHALL carry the SHA-256 of that file's
content in `HEAD` (or the sentinel `absent` for a file the fork deliberately does not have),
and the gate SHALL fail when the committed content no longer matches the recorded hash.

#### Scenario: A fork edit inside an accepted file is reverted by a merge
- **WHEN** a file listed in `divergence.accepted` differs in `HEAD` from its recorded hash
- **THEN** `fork:verify` reports `ACCEPTED DIVERGENCE CHANGED` naming that file and exits non-zero

#### Scenario: A pinned file is unchanged
- **WHEN** an accepted file's `HEAD` content hashes to its recorded value
- **THEN** the gate reports it as accepted and exits zero

#### Scenario: A deliberately absent file reappears
- **WHEN** an accepted entry pinned as `absent` exists in `HEAD`
- **THEN** the gate fails rather than passing, because the pin no longer describes the tree

### Requirement: The divergence config asserts its own shape when parsed
`fork:verify` SHALL validate `divergence.accepted` at parse time, before reading the tree, and
fail on an entry that is a bare path, on a hash that is neither 64 hex characters nor
`absent`, on an accepted path that is also listed in `owned` or `patched`, and on an accepted
path that does not match `divergence.scope`.

#### Scenario: An entry quietly stops being a rule
- **WHEN** an accepted entry is a plain string with no hash
- **THEN** `fork:verify` fails with a message naming the entry, rather than treating the path as an exemption

#### Scenario: A file is both registered and accepted
- **WHEN** a path appears in `owned` or `patched` and also in `divergence.accepted`
- **THEN** `fork:verify` fails, because the accepted entry would suppress the fingerprint check

#### Scenario: An accepted entry is outside the gate's scope
- **WHEN** an accepted path does not match any `divergence.scope` pattern
- **THEN** `fork:verify` fails, because the entry can never be evaluated and reads as a rule that does not exist

### Requirement: The size of the exemption is visible
Each `fork:verify` run SHALL report the number of fingerprinted accepted entries and how many
of them currently diverge from their pin.

#### Scenario: A clean manifest
- **WHEN** every accepted entry matches its pinned hash
- **THEN** the run prints the accepted count and zero drifted entries

### Requirement: Re-baselining writes claims, not paths
`--record-divergence` SHALL write the current `HEAD` fingerprints into
`divergence.accepted`, and `--accept-divergence` SHALL write fingerprinted entries, so the
manifest always satisfies the parse-time validation after either command.

#### Scenario: Recording after a legitimate edit
- **WHEN** an accepted file is legitimately changed and `--record-divergence` is run
- **THEN** the manifest's entry for that file carries the new hash and a later `fork:verify` passes
