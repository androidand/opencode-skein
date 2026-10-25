# Tasks: v2 re-baseline

- [ ] 1.1 `git fetch --unshallow upstream` in `~/dev/opencode-skein`; abort with a clear
      error if any ancestry claim is later made against a shallow repo.
- [ ] 1.2 Pick and record the pinned release tag (v2.1.3); state it in `00-current-state.md`
      and reference it from `01-requirements.md` R-P1.
- [ ] 1.3 Regenerate the fork-vs-upstream delta lists (`git diff --name-only upstream/<tag>
      — filter to `packages/opencode/src/`) as committed data under `docs/skein-2/`.
- [ ] 1.4 Reconcile `00/current-state` numbers against the freshly generated lists; fix
      any escaped drift in `06-work-breakdown.md` and the gap analysis.
- [ ] 1.5 Record fork-specific mutable state paths (config, data, session dirs) for the
      migration decision in `adopt-upstream-acp-and-service`.
- [ ] 1.6 Evidence: post the unshallow assertion and both delta lists in
      `docs/skein-2/00-current-state.md` with the commit SHA of the delta run.
