import type { Candidate, Kind, Options, Origin, Source } from "./spec"
import type { Fx, ModuleNamespace, SpecTarget } from "./common"
import type { PackageRecord } from "./package"

/**
 * Normalized external plugin plan before any filesystem or npm work happens.
 */
export interface Plan {
  /** Original normalized string spec. */
  readonly spec: string
  /** Optional inline config tuple payload. */
  readonly options: Options | undefined
  /** Whether the package is deprecated because the functionality is now built in. */
  readonly deprecated: boolean
}

/**
 * External plugin that has been resolved to a concrete on-disk entrypoint.
 */
export interface Resolved extends SpecTarget {
  /** Options to forward when the plugin is instantiated. */
  readonly options: Options | undefined
  /** Whether the plugin came from a file path or npm install. */
  readonly source: Source
  /** JavaScript module entrypoint that can be dynamically imported. */
  readonly entry: string
  /** Loaded package metadata when a package.json exists. */
  readonly pkg: PackageRecord | undefined
}

/**
 * External plugin target that was found but does not expose the requested runtime entrypoint.
 *
 * This is a first-class result because TUI still cares about theme-only packages.
 */
export interface MissingEntrypoint extends SpecTarget {
  /** Options to forward if some later stage still wants to keep the plugin record. */
  readonly options: Options | undefined
  /** Whether the target came from a file path or npm install. */
  readonly source: Source
  /** Loaded package metadata when a package.json exists. */
  readonly pkg: PackageRecord | undefined
  /** Human-readable explanation of what was missing. */
  readonly message: string
}

/**
 * Resolved plugin whose module has been imported successfully.
 */
export interface Loaded extends Resolved {
  /** Raw dynamic import namespace. */
  readonly module: ModuleNamespace
}

/**
 * Pipeline stages where a plugin load can fail.
 */
export type FailureStage = "install" | "entry" | "compatibility" | "load"

/**
 * External load failure record.
 *
 * This replaces the current callback-heavy report object with an explicit value.
 */
export interface Failure {
  /** Which configured plugin was being processed. */
  readonly candidate: Candidate
  /** Which pass failed. */
  readonly stage: FailureStage
  /** Whether the failure happened during the retry-after-dependencies pass. */
  readonly retry: boolean
  /** Underlying failure object. */
  readonly error: unknown
  /** Best-known resolution details when the failure happened after entry resolution. */
  readonly resolved: Resolved | undefined
}

/**
 * Result of processing one configured external plugin.
 */
export type AttemptResult =
  | {
      /** Successfully resolved and imported plugin module. */
      readonly type: "loaded"
      readonly origin: Origin
      readonly retry: boolean
      readonly value: Loaded
    }
  | {
      /** Target exists but does not expose the requested runtime entrypoint. */
      readonly type: "missing"
      readonly origin: Origin
      readonly retry: boolean
      readonly value: MissingEntrypoint
    }
  | {
      /** Operational failure during install, resolution, compatibility, or import. */
      readonly type: "failed"
      readonly value: Failure
    }

/**
 * Input to the external loading workflow.
 */
export interface LoadRequest {
  /** Ordered merged config origins to process. */
  readonly items: readonly Origin[]
  /** Which runtime is asking for plugins. */
  readonly kind: Kind
  /**
   * Optional dependency-prep effect.
   *
   * If provided, file plugins that failed during the first pass may be retried after this effect completes.
   */
  readonly waitForDependencies: Fx<void> | undefined
}

/**
 * Intended signature for the shared external loader.
 *
 * The return value preserves order and gives callers explicit success, missing-entry, and failure results.
 */
export type LoadExternal = (request: LoadRequest) => Fx<readonly AttemptResult[]>
