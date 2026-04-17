import type { Plugin as ServerPluginFactory, PluginModule as ServerPluginModule } from "@opencode-ai/plugin"
import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { ModuleNamespace } from "./common"

/**
 * Validation mode for imported plugin modules.
 *
 * `strict` means the module must clearly match the expected target shape.
 * `detect` means the loader is probing for a v1 module before falling back to older compatibility paths.
 */
export type ValidationMode = "strict" | "detect"

/**
 * Current v1 server module shape.
 *
 * A v1 module is target-exclusive, so it must not export both `server` and `tui` from the same default export.
 */
export type V1ServerModule = {
  /** Optional logical plugin id. npm plugins may omit this and fall back to package name. */
  readonly id?: string
  /** Server plugin factory used to create hook handlers. */
  readonly server: ServerPluginModule["server"]
  /** Explicitly absent to make the target-exclusive shape obvious. */
  readonly tui?: never
}

/**
 * Current v1 TUI module shape.
 */
export type V1TuiModule = {
  /** Optional logical plugin id. */
  readonly id?: string
  /** TUI plugin factory used to register commands, routes, and UI hooks. */
  readonly tui: TuiPluginModule["tui"]
  /** Explicitly absent to make the target-exclusive shape obvious. */
  readonly server?: never
}

/**
 * Union of the currently supported v1 module shapes.
 */
export type V1Module = V1ServerModule | V1TuiModule

/**
 * Older server plugin export styles still supported for backward compatibility.
 *
 * These only exist on the server side.
 */
export type LegacyServerExport =
  | ServerPluginFactory
  | {
      readonly server: ServerPluginFactory
    }

/**
 * Result of validating an imported module namespace.
 */
export type ValidationResult =
  | {
      /** Namespace matched the modern v1 shape. */
      readonly type: "v1"
      /** Parsed target-exclusive default export. */
      readonly module: V1Module
    }
  | {
      /** Namespace did not match v1 but did contain legacy server plugin exports. */
      readonly type: "legacy-server"
      /** Distinct legacy server plugin factories extracted from the namespace. */
      readonly exports: readonly LegacyServerExport[]
    }

/**
 * Intended signature for the module validation function.
 *
 * This stays separate from the external loader so module-shape rules are easy to inspect on their own.
 */
export type ValidateModule = (
  namespace: ModuleNamespace,
  input: {
    /** Human-readable spec used in error messages. */
    readonly spec: string
    /** Which runtime is being validated. */
    readonly kind: "server" | "tui"
    /** Whether this is a hard validation pass or a soft probe. */
    readonly mode: ValidationMode
  },
) => ValidationResult | undefined
