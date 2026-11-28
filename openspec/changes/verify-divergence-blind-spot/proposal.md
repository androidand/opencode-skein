## Why

`fork:verify` exists for one failure mode: a merge silently deletes a fork feature
and nothing notices. The `divergence` gate is supposed to be the ratchet that catches
it. It currently does not, because `divergence.accepted` is a **path** list, not a
content claim: once a file's path is in `accepted`, the gate skips it whatever its
contents become (`script/fork-verify.ts:105` — `filter(f => !registered.has(f) && !accepted.has(f))`).

Measured on `origin/dev` at `0e47c2fe1c2`:

- `divergence.accepted` holds **105** entries.
- **93** of them are inside the gate's own scope (`^packages/[^/]+/(src|test)/`) and
  differ from `baseline.upstreamRef` right now — 93 files, +233/−189 lines, including
  `packages/core/src/ripgrep.ts`, `packages/core/src/event.ts`,
  `packages/core/src/session/projector.ts`, `packages/opencode/src/session/processor.ts`.
  Every one of those edits is invisible to the gate.
- `divergence.note` asserts "The single remaining accepted entry is
  `packages/core/src/effect/dfdf`". It has 105. The one prose sentence that describes
  the exemption list is false, so nobody reading the manifest can tell how big the hole is.
- `fork:verify` checks the committed state (`HEAD`) for `owned` and `patched` files
  (`script/fork-verify.ts:42-52`, with a comment explaining exactly why worktree-only is
  not enough) but never for `accepted` files — the class most likely to be reverted by a
  merge, because those are upstream files the fork has edited.

This matters most at the next upstream re-sync, where the merge base is useless (dev and
`upstream/dev` share 94 commits) and reconciliation will be done by hand across 169
files both sides touched. The files that get hand-reconciled are exactly the ones in the
exemption list.

## What Changes

- An accepted entry becomes a **content claim**, not a path exemption:
  `{ file, hash, note }`, where `hash` is the SHA-256 of that file's content **in `HEAD`**
  (or the sentinel `"absent"` for a file the fork deliberately deleted, e.g. `effect/dfdf`).
  If `HEAD`'s content no longer matches, the gate FAILS with `ACCEPTED DIVERGENCE CHANGED`
  and names the file: it must then be classified (register as `owned`/`patched`, revert as
  drift, or deliberately re-record).
- A plain-string accepted entry becomes a hard failure, so the exemption list can never
  silently regress to path-only immunity. The manifest is migrated in this change, so the
  rule passes from the first commit.
- Load-time assertions on the config itself, at the point it is parsed: an accepted entry
  must carry a 64-hex (or `"absent"`) hash; it must not also appear in `owned`/`patched`
  (a duplicate would take the fingerprint check away while looking registered); it must
  match the scope regex (an out-of-scope entry is dead weight that reads like a rule).
- `--record-divergence` writes the current `HEAD` fingerprints into the manifest, and
  `--accept-divergence` keeps its meaning (re-baseline the accepted set) but writes
  fingerprinted entries rather than bare paths.
- `divergence.note` is corrected to describe the list as it is, and the count is printed on
  every run (`accepted: 105 fingerprinted`) so the size of the exemption is visible in the
  output instead of only in prose.

## Impact

- Affected specs: `fork-integrity`
- Affected code: `script/fork-verify.ts`, `fork/manifest.json`, `.husky/pre-push` (unchanged
  behaviour, new failure mode), new `script/fork-verify.test.ts`
- Not done here, deliberately: the 93 accepted in-scope files are **not** classified as
  feature vs drift. Fingerprinting makes an unclassified file safe to merge against; it does
  not make it registered. Classifying them stays a separate change.
