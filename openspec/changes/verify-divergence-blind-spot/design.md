## Context

`fork/manifest.json` is read as instructions by `script/fork-verify.ts`. Today the
`divergence.accepted` list is a set of paths, so it grants immunity by name. The failure this
fork keeps hitting — a merge deleting a fork edit — is invisible for any file whose name is
on that list, which is 93 in-scope files at the time of writing.

The gate also has an asymmetry it documents but does not enforce: it reads `HEAD` for
`owned` and `patched` because "a marker present in the worktree but missing from HEAD is
exactly how the fork loses features in practice", and then evaluates the divergence gate
against the working tree only.

## Goals / Non-Goals

**Goals**
- Make the exemption checked instead of assumed: an accepted entry pins the committed bytes.
- Make the config assert its own shape when parsed, so an entry cannot quietly stop being a
  rule (string instead of fingerprint, duplicate of a registered file, out of scope).
- Keep `--strict` and `--accept-divergence` semantics; add `--record-divergence`.
- Prove by test that the gate goes red when the pinned bytes change.

**Non-Goals**
- Classifying the 93 accepted files as feature or drift. That is a separate change; a
  fingerprint is a safety net, not a classification.
- Changing the merge/rebase strategy for upstream syncs.
- Re-baselining `baseline.upstreamRef` (it points at `4643e65ad63`, a commit that is not in
  dev's lineage because upstream rewrote history; fixing that is sync work, not gate work).

## Decisions

**Decision 1: pin `HEAD` content, not worktree content.**
`hash` is SHA-256 of `git show HEAD:<file>`. The thing that gets pushed is `HEAD`, and the
existing owned/patched check already argues for `HEAD`. The worktree stays the place where a
mid-edit state is allowed. For a file absent from `HEAD` the hash is the sentinel `"absent"`
— that still carries information: if upstream re-adds `packages/core/src/effect/dfdf`, the
recorded `"absent"` no longer matches and the gate fails rather than passing.

**Decision 2: string accepted entries are an error, not a supported legacy form.**
A migration is one machine-generated pass, so carrying a permissive legacy shape would mean
shipping a gate that is once again immune by name for any entry someone forgets to migrate.
`--record-divergence` performs the migration; the gate refuses to run against a manifest with
bare-string entries.

**Decision 3: assertions live at parse time, in the gate, not in review.**
`validateAccepted(manifest)` runs before any filesystem or git work and fails closed on:
a missing/short/non-hex hash; an accepted file that is also `owned` or `patched`; an accepted
file that does not match `divergence.scope`. This is the part that makes the fix durable — the
hole is closed by a check that runs with no human holding two files in mind.

**Decision 4: `fork-verify.ts` exports pure functions over injected readers.**
Today it runs at import and calls `process.exit`, so it cannot be tested. It is split into
`parseManifest`, `validateAccepted`, `acceptedStatus`, `collectDivergence` (pure, taking a
`readHead` function and a diff-name list) plus a `main()` guarded by `import.meta.main`.
Tests inject a fake reader, so a fingerprint mismatch is exercised without building a git repo.

**Rejected alternative: register all 93 as `patched` with marker strings.**
A marker is a substring, and a 2-line edit in a file the fork barely touches does not have a
stable marker worth asserting. Content pinning needs no marker and cannot match by accident.

## Risks / Trade-offs

- **Re-baseline churn.** Any legitimate edit to an accepted file now needs
  `--record-divergence`. Mitigation: the failure names the file and prints the command; the
  re-record is one command and shows up in the diff for review.
- **A fingerprint can be re-recorded carelessly.** It is still one deliberate command, and the
  manifest diff is the review surface — which is strictly better than today's silence.
- **Hash of a large file per run.** ~105 `git show` reads, sub-second; the gate already runs
  `git show` for all 288 owned and 118 patched files.

## Migration order

1. Refactor `fork-verify.ts` to exported pure functions + `import.meta.main`.
2. `--record-divergence` writes fingerprints for the current accepted set.
3. Run it, commit the regenerated `fork/manifest.json`, corrected `note`.
4. `fork:verify` green; `--strict` green.
