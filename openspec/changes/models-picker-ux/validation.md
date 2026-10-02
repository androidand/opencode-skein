# Validation: models-picker-ux

This change is purely TypeScript/TSX — no Go code. Skip Go test targets.

## Validation Commands

```bash
# Typecheck all affected packages
bun run typecheck

# Run relevant test suites
bun test packages/tui/test/ui/dialog-select-footer.test.ts
bun test packages/tui/test/ui/dialog-model-fit.test.ts
bun test packages/tui/test/ui/dialog-select-fit.test.ts
bun test packages/opencode/test/provider/merge-discovered-model.test.ts
```

## Baseline

- Typecheck: clean (30/30 tasks pass)
- Lint: 2 errors + 5417 warnings — all pre-existing
- tui tests: 236 pass / 10 fail (10 pre-existing)
- core tests: 1092 pass / 1 fail (1 pre-existing)
- merge-discovered-model: 4 pass
