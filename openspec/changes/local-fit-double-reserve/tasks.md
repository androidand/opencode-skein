# Tasks: local-fit-double-reserve

- [ ] 1. Write the failing test first, in the overflow tests: a model with `limit.context` 67,174, `limit.output` 8,192, marked fit-derived. `usable()` must return 65,126 (67,174 − 2,048). It MUST fail on `dev`, which returns 58,982.
- [ ] 2. Mark fit-derived models during discovery (only when `fit.maxSafeCtx` was used for `limit.context`).
- [ ] 3. In `usable()`, use the small buffer for fit-derived models. An explicit `compaction.reserved` still wins. Test both.
- [ ] 4. Test that a model that is not fit-derived is unchanged.
- [ ] 5. Show the compaction trigger in the context meter next to the configured context.
- [ ] 6. Check what happens when a prompt does exceed the host's budget anyway (HTTP 413): the existing overflow handling must still compact and retry. Test it.
- [ ] 7. Run the package tests and typecheck.
