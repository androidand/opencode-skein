# Tasks: context-meter-threshold

- [ ] 1. Settle the source of the threshold and record it here in one paragraph: server-exposed, TUI-computed with a pinning test, or config-only. State which files change and what happens to the 2,048 buffer.
    Do not start task 2 or 3 before this is written down. The three options in `proposal.md` are not interchangeable and the cheap one is the one that can rot silently.
- [ ] 2. Write the failing display test first: for a fit-derived model with `limit.context` 67,174, `limit.contextMax` 81,920 and threshold 65,126, the meter string must carry the threshold and the percentage must be measured against it. It must fail before the change.
- [ ] 3. Implement the meter in `packages/tui/src/feature-plugins/sidebar/context.tsx`.
- [ ] 4. If the threshold is duplicated in the client rather than sent by the server, add the test that fails when the client constant and `FIT_DERIVED_BUFFER` in `packages/opencode/src/session/overflow.ts` disagree. A test that passes on both values is not this test.
- [ ] 5. Check the other two bare token displays (`packages/tui/src/routes/session/subagent-footer.tsx:43`, `packages/tui/src/component/prompt/index.tsx:396`) and either bring them in line or record here why they are left alone.
- [ ] 6. Check a cloud model and a fit-derived model side by side: the cloud case must look exactly as it does today.
- [ ] 7. Run `bun typecheck` from `packages/tui` and `packages/opencode`, and the package's test suites.
