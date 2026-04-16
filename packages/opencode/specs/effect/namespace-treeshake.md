# Namespace → self-reexport migration

Migrate `export namespace` to flat module exports with a self-referential
`export * as` at the bottom of each file. No barrel files.

## The pattern

Each module file has flat exports plus one line at the bottom that re-exports
itself as a namespace:

```ts
// config/config.ts
import { Log } from "../util/log"

export interface Info { model: string }
export function load(): Info { ... }
export const JsonError = NamedError.create(...)

// Self-reexport: creates a named `Config` export that consumers can import
export * as Config from "./config"
```

Consumers import the namespace by name — editors auto-import this like any
named export:

```ts
import { Config } from "../config/config"
Config.load()
Config.JsonError.isInstance(x)
```

## Why this pattern

We tested every option with Bun. Three things matter: tree-shaking, circular
imports, and editor autocomplete.

```
A. Barrel (export * as Foo + Bar from index.ts)
   Runtime:  foo LOADED even though only Bar used  ❌
   Bundled:  foo LOADED if it has side effects     ❌
   Autocomplete: works (named export from barrel)

B. import * as Bar from "./bar" (direct, no barrel)
   Runtime:  only bar loaded                       ✅
   Bundled:  only bar loaded                       ✅
   Autocomplete: broken (editors can't auto-import) ❌

C. Self-reexport: export * as Bar from "./bar" inside bar.ts
   Runtime:  only bar loaded                       ✅
   Bundled:  only bar loaded                       ✅
   Autocomplete: works (named export from file)    ✅
```

The self-reexport gives us tree-shaking + autocomplete + no barrels.

### Bundle overhead

The self-reexport adds ~240 bytes per module (an `Object.defineProperty`
wrapper). At 100 modules that's ~24KB — irrelevant for a CLI binary.

### The `Foo.Foo.Foo` thing

`Config.Config.Config.load()` compiles and runs. It's a harmless side effect
of self-referential modules. Nobody would write it.

## Why barrel files don't work

Barrel files (`index.ts` with `export * as`) have two problems:

1. **Bun loads all re-exported modules** when you import through a barrel,
   even if you only use one. This happens at both runtime and bundle time
   for modules with side effects (which ours have — top-level imports).

2. **Circular import risk.** Sibling files can't import through their own
   barrel, and cross-directory barrel cycles cause runtime `ReferenceError`.

## The migration

There are two tasks:

### Task 1: Convert remaining `export namespace` files (~50)

For each file:

1. Remove the `export namespace Foo {` wrapper and closing `}`
2. Dedent the body
3. Add `export * as Foo from "./file"` at the bottom
4. Rewrite consumer imports: `import { Foo } from "..."` stays the same
   if the path already points at the file. If it points at a barrel,
   change it to point at the file directly.

### Task 2: Fix already-converted files (~32 barrel dirs)

These were converted in the earlier barrel-based migration. Each directory
has an `index.ts` barrel and flat-exported source files. To migrate:

1. Add `export * as Foo from "./file"` to the bottom of each source file
2. Change consumers from `import { Foo } from "../dir"` (barrel) to
   `import { Foo } from "../dir/file"` (direct)
3. The barrel `index.ts` can be deleted or left in place (harmless once
   nothing imports through it)

### Automation

```bash
# Convert an unconverted namespace file:
bun script/unwrap-namespace.ts src/session/session.ts --dry-run
bun script/unwrap-namespace.ts src/session/session.ts

# Retrofit an already-converted file (add self-reexport + fix consumers):
bun script/unwrap-namespace.ts src/config/config.ts --retrofit --dry-run
bun script/unwrap-namespace.ts src/config/config.ts --retrofit
```

The script handles both cases:

- **Default mode**: unwraps namespace + adds self-reexport + rewrites imports
- **Retrofit mode** (`--retrofit`): file already has flat exports, just adds
  the self-reexport line and rewrites consumers from barrel to direct

### Verification

After any conversion:

```bash
bunx --bun tsgo --noEmit                                # typecheck
bun run --conditions=browser ./src/index.ts generate    # circular import check
```

## Rules for new code

- **No `export namespace`.** Use flat named exports.
- **No barrel `index.ts` for internal code.**
- **Every module file gets a self-reexport** at the bottom:
  `export * as Foo from "./foo"`
- **Consumers import the namespace by name:**
  `import { Foo } from "../path/to/foo"`

## Remaining work

### Unconverted (~50 namespaces):

**Session directory (14)** — deep cross-directory cycles currently via barrel:

- SessionRunState, SystemPrompt, Message, SessionRetry, SessionProcessor,
  SessionRevert, Instruction, SessionSummary, Todo, LLM, SessionStatus,
  SessionCompaction, SessionPrompt, MessageV2

**Special cases:**

- `flag/flag.ts` — uses `Object.defineProperty(Flag, ...)`, needs restructuring
- `account/repo.ts` — ast-grep fails, needs manual conversion
- `v2/` (multi-namespace files) — SessionEvent (5 nested), etc.

**Other standalone modules** (~30 across server/, cli/, plugin/, etc.)

### Already converted (32 barrel dirs) — need retrofit:

config, provider, bus, mcp, effect, util, file, tool, storage, lsp,
project, plugin, permission, skill, auth, env, worktree, ide, snapshot,
installation, pty, share, cli/cmd/tui/util, plugin/github-copilot, etc.
