# Tasks: local-provider-disconnect-sticky

- [x] 1.1 Ignore list persisted at `local-ignored.json`; `/disconnect` adds, `/connect` removes
- [x] 1.2 Extract `reconcileProviders` as a pure function and honor the ignore list
- [x] 1.3 Unit tests for the reconcile decision and the ignore list
- [x] 1.4 `bun test test/local`: the new tests pass; the one failure is the pre-existing
      `discovery.integration.test.ts` (live Bonjour scan within 5 s — network timing, unrelated)
