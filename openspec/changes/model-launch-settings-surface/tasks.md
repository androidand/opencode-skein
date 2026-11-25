# Tasks: model-launch-settings-surface

Blocked on llama-skein `add-model-launch-settings-fields` (fields and dry run). The
failure/rollback tasks also need `fix-crash-loop-start-failures`. Each task degrades
against a host without its server support; develop against a fake host first.

- [ ] 1. Resolve D1's open question with the plugin-extraction owner: does the plugin API gain a `cli.command` hook? Record the answer in `design.md`. Until it is answered, do tasks 2-5 (plugin side) only; they do not depend on it.
- [ ] 2. One UI-free module that reads launch settings, builds a patch, requests a dry run, and renders warnings and rollback info, using the generated llama-skein SDK. Verify: `bun test` with a fake host covering unsupported, supported, and warning-bearing responses; each test observed failing before the module exists.
- [ ] 3. Capability detection per control (`launch-settings`, `config-history`, `dry-run`) with the hide-not-break behaviour. Verify: a test per missing capability asserting only that control is absent.
- [ ] 4. The Launch section in the per-model dialog as a feature plugin, sibling of the Placement section from `per-model-placement-controls`. Verify: `cd packages/tui && bun run typecheck`; render test for read-only and editable states.
- [ ] 5. Failure display and the rollback action with the D4 confirmation (Cancel focused, snapshot summary, reload cost). Verify: test that confirming calls the rollback once and cancelling calls nothing.
- [ ] 6. The thin core subcommand `opencode models config` over the same module (only if task 1 says no plugin CLI hook). Verify: `--dry-run` writes nothing (fake host asserts zero PATCH without `dry_run`), `--rollback` without `--yes` prompts, `--json` parses.
- [ ] 7. `bun run arch:check` (the monorepo layering rule) still passes, and the diff to core is only the one `.command(...)` line. Record the core diff size in this file.
- [ ] 8. Live check against a real llama-skein host with a deliberately bad flag: the dialog shows the engine's reason, previews the fix, rollback restores the snapshot, and nothing happens without a confirmation. Record the host's responses.
