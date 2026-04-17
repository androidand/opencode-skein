/**
 * Small helper alias used throughout this folder so the design signatures stay readable.
 *
 * These files are only a type sketch, so we reference the Effect type without creating any runtime code.
 */
export type Fx<Success, Error = never, Requirements = never> = import("effect").Effect.Effect<
  Success,
  Error,
  Requirements
>

/**
 * Standard success result shape used by the sketch files.
 *
 * The current plugin code already uses similar tagged unions in a few places.
 */
export type Ok<Value> = {
  ok: true
  value: Value
}

/**
 * Standard failure result shape used by the sketch files.
 *
 * `code` stays machine-friendly while the extra data explains the specific failure.
 */
export type Failure<Code extends string, Data> = {
  ok: false
  code: Code
} & Data

/**
 * Generic loaded module namespace.
 *
 * Dynamic imports return a namespace object, and the next stage decides whether that namespace is a
 * v1 module, a legacy server export set, or an invalid module.
 */
export type ModuleNamespace = Record<string, unknown>

/**
 * Shared shape for objects that carry both a configured spec and its resolved on-disk target.
 */
export interface SpecTarget {
  /** The original normalized plugin spec, for example `pkg@1.2.3` or `file:///.../plugin.ts`. */
  readonly spec: string
  /** The resolved install location or local file URL that later stages work against. */
  readonly target: string
}
