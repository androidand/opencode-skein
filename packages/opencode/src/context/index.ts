/**
 * ContextManager — a named, typed, async-local context abstraction.
 *
 * Replaces the scattered `LocalContext.create<T>()` calls across the
 * codebase with a single, centrally-managed registry of named context
 * managers.  Each manager owns one `AsyncLocalStorage` instance and
 * exposes typed `provide` / `use` methods plus validation helpers.
 *
 * ## Design
 *
 * 1. `create(name)` — factory that builds a manager for one typed slot.
 * 2. `provide(value, fn)` — runs `fn` with `value` bound to this slot.
 * 3. `use()` — reads the current value; throws `NotFound` when absent.
 * 4. `tryUse()` — reads the current value; returns `undefined` when absent.
 * 5. `isSet()` / `ensureSet()` — lightweight guards before deep calls.
 *
 * Every manager is registered in the global `registry` map keyed by its
 * name, which makes debugging and introspection trivial.
 *
 * @module context
 */

import { AsyncLocalStorage } from "async_hooks"

// ── Errors ────────────────────────────────────────────────────────────

export class NotFound extends Error {
  constructor(public readonly name: string) {
    super(`No ${name} context available`)
  }
}

export class DuplicateNameError extends Error {
  constructor(public readonly name: string) {
    super(`Context "${name}" already registered`)
  }
}

// ── Registry ──────────────────────────────────────────────────────────

interface Manager<A> {
  readonly name: string
  readonly store: AsyncLocalStorage<A>
  provide(value: A, fn: () => void): void
  use(): A
  tryUse(): A | undefined
  isSet(): boolean
}

const registry = new Map<string, Manager<unknown>>()

/**
 * Create a new named context manager.
 * Throws `DuplicateNameError` if a manager with the same name already exists.
 */
export function create<A>(name: string): Manager<A> {
  if (registry.has(name)) {
    throw new DuplicateNameError(name)
  }

  const store = new AsyncLocalStorage<A>()

  const manager: Manager<A> = {
    name,
    store,

    provide(value: A, fn: () => void): void {
      store.run(value, fn)
    },

    use(): A {
      const result = store.getStore()
      if (!result) {
        throw new NotFound(name)
      }
      return result
    },

    tryUse(): A | undefined {
      return store.getStore()
    },

    isSet(): boolean {
      return store.getStore() !== undefined
    },
  }

  registry.set(name, manager as Manager<unknown>)
  return manager
}

/**
 * Look up a registered manager by name.
 * Returns `undefined` if no manager was ever created with that name.
 */
export function lookup(name: string): Manager<unknown> | undefined {
  return registry.get(name)
}

/**
 * List all registered context manager names (useful for debugging).
 */
export function list(): string[] {
  return [...registry.keys()]
}

/**
 * Reset the registry — primarily for tests.
 */
export function reset(): void {
  registry.clear()
}

// ── Re-export for backwards compatibility ─────────────────────────────

/**
 * Legacy compatibility shim.  Prefer `create()` from this module directly.
 * Kept so existing import paths (`@/util/local-context`) keep working
 * during the migration window.
 */
export const LocalContextCompat = {
  create<A>(name: string): {
    use: () => A
    provide: (value: A, fn: () => void) => void
  } {
    const mgr = create<A>(name)
    return {
      use: () => mgr.use(),
      provide: (value, fn) => mgr.provide(value, fn),
    }
  },
} as const
