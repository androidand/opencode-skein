# Monorepo package dependencies

Generated 2026-11-25 with dependency-cruiser 18.5.0 over `packages/*/src`.
Regenerate the table with `bun run arch:edges`; check the layering rules with
`bun run arch:check`. Both read `.dependency-cruiser.cjs`.

## Summary

- 25 of the 32 packages have a `src/` directory. Between them there are
  **36 cross-package edges**, and every `@opencode-ai/*` import resolves.
- The package graph has no cycles. `schema` is the base layer, and `core` is
  the hub: 8 packages import it, and `opencode → core` alone is 536 imports.
- No foundation package (`core`, `effect-*`, `protocol`, `identity`, `llm`,
  `function`, `schema`, `httpapi-codegen`) imports a surface package (`app`,
  `console`, `cli`, `desktop`, `containers`, `opencode`, `web`, `enterprise`).
  `arch:check` enforces this rule.
- `plugin` is a leaf, and only `core` imports it (3 imports).

An earlier draft of this document reported 2 cross-package edges and
"extremely loose coupling". That count was an artifact: the config did not read
package `exports` maps, so every `@opencode-ai/*` import went unresolved and was
silently dropped. `arch:edges`, and therefore `arch:check`, now exits 1 in three
cases:

- an `@opencode-ai/*` import does not resolve
- the cruise comes back near-empty
- the layering rule is broken

Each of the three was observed failing before this document was written.

## Cross-package edges

| from | to | imports |
| --- | --- | ---: |
| app | core | 60 |
| app | schema | 1 |
| app | session-ui | 31 |
| app | ui | 599 |
| cli | core | 8 |
| cli | server | 2 |
| cli | tui | 2 |
| client | protocol | 2 |
| client | schema | 21 |
| core | effect-drizzle-sqlite | 1 |
| core | llm | 23 |
| core | plugin | 3 |
| core | schema | 51 |
| desktop | app | 6 |
| desktop | ui | 4 |
| enterprise | core | 5 |
| enterprise | session-ui | 6 |
| enterprise | ui | 14 |
| llm | schema | 2 |
| opencode | codemode | 1 |
| opencode | core | 536 |
| opencode | llm | 9 |
| opencode | protocol | 1 |
| opencode | schema | 21 |
| opencode | server | 12 |
| opencode | tui | 33 |
| protocol | schema | 50 |
| sdk-next | client | 2 |
| sdk-next | core | 5 |
| sdk-next | server | 1 |
| server | core | 52 |
| server | protocol | 18 |
| session-ui | core | 13 |
| session-ui | ui | 128 |
| tui | core | 15 |
| tui | ui | 5 |
