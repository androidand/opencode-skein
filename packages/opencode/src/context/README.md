# `@/context` — Named Context Management

Provides a unified, typed, async-local context manager for the opencode codebase.

## Why

Before this module, each context type (`InstanceContext`, `WorkspaceContext`, etc.)
created its own `LocalContext` instance via a local `LocalContext.create<T>()` call.
This scattered pattern made it difficult to:

- Debug which contexts are active
- Track context lifecycle
- Introspect registered contexts

The new `ContextManager` abstraction centralizes all named context managers in a
single registry, while preserving the same async-local semantics.

## API

```ts
import { create, lookup, list, reset } from "@/context"

// Create a typed, named context manager
const ctx = create<MyContext>("my-context")

// Provide a value for the duration of a callback
ctx.provide({ key: "value" }, () => {
  const current = ctx.use()  // => { key: "value" }
})

// Try to read without throwing
const maybe = ctx.tryUse()  // => MyContext | undefined

// Check if a value is present
if (ctx.isSet()) { /* ... */ }

// Look up any registered manager by name
const all = lookup("my-context")  // => Manager<unknown> | undefined

// List all registered context names
const names = list()  // => string[]

// For tests: clear the registry
reset()
```

## Migration

To migrate an existing `LocalContext` usage:

```diff
- import { LocalContext } from "@/util/local-context"
+ import { create } from "@/context"

- const context = LocalContext.create<MyContext>("name")
+ const context = create<MyContext>("name")
```

The `provide`/`use`/`tryUse`/`isSet` APIs are identical, so no caller changes are needed.

## Testing

```bash
bun test test/context/index.test.ts
```
