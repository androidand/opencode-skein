# Tasks: verify-divergence-blind-spot

This change was already half-implemented and left uncommitted in this worktree by an
earlier session. The implementation is preserved as commit `e1db5cbf6dc` (message says
`wip:` and records that its own manifest self-check was red at that commit); the rest of
this file is the work finished on 2026-11-28. Every task below states what was observed,
not what was intended.

- [x] 1. `fork-verify.test.ts`: an accepted entry whose pinned bytes changed in `HEAD` makes the gate report that file.
    **Result (2026-11-28):** `script/fork-verify.test.ts:62` ("a merge that reverts an accepted file's content is caught") plus `:74` (a pin whose file is missing from HEAD is reported, not skipped). Honest note on the "red before the fix" claim: the old `script/fork-verify.ts` on `origin/dev` has no `acceptedStatus` and no hash concept at all, so this test cannot be run against it — the pre-fix code has nothing to assert on. What *was* observed red is the two real-data cases: the self-check on the fork's own manifest failed against the pre-migration manifest (107 problems, `11 pass / 1 fail`), and the drift test failed when a real pin was corrupted (see task 4).
- [x] 2. Split `fork-verify.ts` into exported pure functions (`parseManifest`, `validateAccepted`, `acceptedStatus`, `collectDivergence`) with an injected `readHead` reader; `main()` behind `import.meta.main`; no behaviour change yet.
    **Result (2026-11-28):** all four exported, `HeadReader` is a type, `main()` runs behind `if (import.meta.main) main()` (`script/fork-verify.ts:353`). Added one more exported reader during the finish: `gitHeadReader(root, ref = "HEAD")`, extracted from the inline closure in `main()` so the real-manifest test in task 7 can inject the same HEAD reader the gate uses. `main()` now calls `gitHeadReader(root)`; behaviour unchanged.
- [x] 3. `validateAccepted`: reject a bare-string accepted entry, a non-64-hex / non-`absent` hash, an accepted path that is also `owned`/`patched`, and an accepted path outside `divergence.scope`.
    **Result (2026-11-28):** four tests, one per case: `script/fork-verify.test.ts:33`, `:40`, `:45`, `:57`. All pass. The parse-time rejection is what makes the config a rule again: an entry that pins nothing is now an error rather than a silent exemption, and the gate refuses to run on an invalid manifest (except under the two rewriting flags, which print that they are rewriting).
- [x] 4. `acceptedStatus`: compare the recorded hash against `HEAD`; emit `ACCEPTED DIVERGENCE CHANGED` and a non-zero exit on mismatch; `absent` matches a file missing from `HEAD` and fails when it reappears, tested both directions.
    **Result (2026-11-28):** `script/fork-verify.test.ts:80` covers both directions of the `absent` pin, `:89` covers a stale entry (no longer differs from baseline → reported, not exempt). The check reads `HEAD`, not the worktree, so a worktree-only edit cannot mask drift. **Counter-example run (the check is a check):** setting one real accepted entry's hash in `fork/manifest.json` to `"a"×64` turned the gate red both ways — `11 pass / 1 fail` with `the fork's own manifest reports no accepted entry that drifted from HEAD` failing, and `bun run fork:verify` printing `ACCEPTED DIVERGENCE CHANGED … FAIL — 1 new regression(s)` and exiting 1. The manifest was restored from `/tmp/fork-manifest-backup.json` and re-verified green.
- [x] 5. `--record-divergence` writes fingerprints from `HEAD`; `--accept-divergence` writes fingerprinted entries instead of bare paths, tested so its output re-satisfies `validateAccepted`.
    **Result (2026-11-28):** `script/fork-verify.test.ts:111` ("re-pinning writes fingerprints, keeps notes, and survives validation") — note the existing note is preserved and an entry with no HEAD content becomes `absent`. Real run: `bun run fork:verify --record-divergence` printed `re-pinned 105 accepted entries to their current HEAD content` and the rewritten manifest then reports `0 bare, 104 pinned, 1 absent`. **Deliberate restraint:** `--accept-divergence` re-baselines by *widening* — it pins every in-scope file that currently differs from baseline. It was not run; the accepted set stayed at exactly 105 entries.
- [x] 6. Regenerate `fork/manifest.json`: accepted entries fingerprinted, `note` corrected to state the real count and rule; run `bun run fork:verify` and `--strict` from a clean tree and record both.
    **Result (2026-11-28):** 105 accepted entries — 104 sha256-pinned at HEAD, 1 `absent` (`packages/core/src/effect/dfdf`). The old note claimed "The single remaining accepted entry is packages/core/src/effect/dfdf", which was false: 105 entries were exempt by path, and their contents were unchecked. New note states the real counts, the rule (an accepted entry is a pinned-content claim; a bare path is refused at parse time), that pinning is not classification, that stale entries should be deleted rather than re-pinned, and both rewriting commands. Only the note line was rewritten; the rest of the file is byte-identical apart from the regenerated `accepted` array. Both runs, from a clean tree:
    ```
    bun run fork:verify
      owned files:   288/288 present
      patched files: 118/118 intact
      divergence:    0 unregistered (105 accepted pinned, 0 drifted, 12 stale)
    OK — no new regressions.

    bun run fork:verify --strict   →   OK — no new regressions.
    ```
- [x] 7. Print the exemption size on every run (`accepted: N fingerprinted, M drifted`) so the hole is visible, and add the test that a clean manifest reports 0 drifted.
    **Result (2026-11-28):** the run line is `divergence: 0 unregistered (105 accepted pinned, 0 drifted, 12 stale)` — pinned, drifted and stale counts on every run. New test `the fork's own manifest reports no accepted entry that drifted from HEAD` reads the real `fork/manifest.json`, diffs against `baseline.upstreamRef`, and injects `gitHeadReader(root)`; it asserts `drifted` is empty and that `fingerprinted + absent` equals the accepted count (so an entry that silently stopped being pinned also fails). Suite after this: `12 pass, 0 fail, 23 expect() calls`. Red-observed by corruption, per task 4.
- [x] 8. Gates: `bun typecheck`, `bun run fork:verify` at root, targeted `bun test script/fork-verify.test.ts`; PR names the unclassified files as explicitly not covered.
    **Result (2026-11-28):** see the PR body. Recorded honestly there: the 104 pinned entries are pinned, not classified; the 12 stale entries are left in place and reported every run rather than deleted; and neither CI nor `bun turbo test` exercises `script/` — the gate is enforced only by `.husky/pre-push`, so a green CI proves nothing about these pins.

## Not covered

- The 104 pinned files are still unclassified: a pin asserts "this content has not changed since this baseline", not "this difference is an intended fork feature". Sorting them into `owned`/`patched` versus upstream drift is separate, deliberately larger work.
- The 12 stale accepted entries (mostly `packages/ui/src/assets/icons/file-types/*.svg` and `packages/ui/src/components/file-icons/sprite.svg`, which no longer differ from `baseline.upstreamRef`) were not deleted. Deleting an exemption is a classification decision, and one of them (`sprite.svg`) is a generated fork asset whose regeneration could legitimately re-diverge.
- No CI enforcement: `.github/workflows/test.yml` runs `bun turbo test`, which covers package workspaces; `script/` is not a package, and no workflow runs `bun run fork:verify`. The test and the gate therefore run only through the local `pre-push` hook.
- `--accept-divergence` can widen the exemption by design (it pins everything currently diverging in scope). That is the documented migration path, but it is a foot-gun and this change does not gate it behind an extra confirmation.
