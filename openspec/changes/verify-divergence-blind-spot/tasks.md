- [ ] 1. `fork-verify.test.ts`: accepted entry whose pinned bytes changed in `HEAD` makes the
      gate report that file (red before the fix — the concept does not exist yet)
- [ ] 2. Split `fork-verify.ts` into exported pure functions (`parseManifest`,
      `validateAccepted`, `acceptedStatus`, `collectDivergence`) with an injected `readHead`
      reader; `main()` behind `import.meta.main`; no behaviour change yet
- [ ] 3. `validateAccepted`: reject a bare-string accepted entry, a non-64-hex/non-`absent`
      hash, an accepted path that is also `owned`/`patched`, and an accepted path outside
      `divergence.scope` — each with its own test
- [ ] 4. `acceptedStatus`: compare the recorded hash against `HEAD`; emit
      `ACCEPTED DIVERGENCE CHANGED` and a non-zero exit on mismatch; `absent` matches a file
      missing from `HEAD` and fails when it reappears (test both directions)
- [ ] 5. `--record-divergence` writes fingerprints from `HEAD`; `--accept-divergence` writes
      fingerprinted entries instead of bare paths (test that its output re-satisfies
      `validateAccepted`)
- [ ] 6. Regenerate `fork/manifest.json`: all 105 accepted entries fingerprinted, `note`
      corrected to state the real count and rule; run `bun run fork:verify` and `--strict`
      from a clean tree and record both results
- [ ] 7. Print the exemption size on every run (`accepted: N fingerprinted, M drifted`) so
      the hole is visible in output, and add the test that a clean manifest reports 0 drifted
- [ ] 8. `bun typecheck` in `packages/opencode`, `bun run fork:verify` at root, targeted
      `bun test script/fork-verify.test.ts`; PR with the 93 unclassified files named as
      explicitly not covered
