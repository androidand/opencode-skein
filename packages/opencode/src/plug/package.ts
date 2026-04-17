import type { Kind, Source } from "./spec"

/**
 * Raw package.json object for a plugin package.
 *
 * The real implementation would read this from disk and then derive higher-level capability types
 * from it.
 */
export type PackageJson = Record<string, unknown>

/**
 * Package metadata resolved from a plugin target on disk.
 */
export interface PackageRecord {
  /** Root directory that owns the package.json. */
  readonly dir: string
  /** Absolute path to the package.json file. */
  readonly pkg: string
  /** Parsed package.json content. */
  readonly json: PackageJson
}

/**
 * Why a runtime target was inferred from a package.
 *
 * This makes install and diagnostics code easier to read because the source of a capability is explicit.
 */
export type CapabilityReason = "server-export" | "tui-export" | "package-main" | "themes"

/**
 * One runtime capability inferred from package metadata.
 */
export interface Capability {
  /** Which runtime this capability belongs to. */
  readonly kind: Kind
  /** Why this capability exists. */
  readonly reason: CapabilityReason
  /** Optional default config written during install when the package provides it. */
  readonly options: Record<string, unknown> | undefined
}

/**
 * Summary of theme assets declared by a package.
 */
export interface ThemeManifest {
  /** Directory that relative theme paths should be resolved from. */
  readonly root: string
  /** Package-relative theme files that survived validation. */
  readonly files: readonly string[]
}

/**
 * Compatibility information declared by an npm package.
 */
export interface Compatibility {
  /** Whether the compatibility gate was actually checked. */
  readonly checked: boolean
  /** The running opencode version used during the check. */
  readonly runtimeVersion: string
  /** The declared `engines.opencode` range, if any. */
  readonly range: string | undefined
}

/**
 * Package inspection result after a target has been resolved.
 */
export interface PackageResolution {
  /** Normalized plugin spec. */
  readonly spec: string
  /** External source kind. */
  readonly source: Source
  /** Resolved install directory or file URL. */
  readonly target: string
  /** Loaded package metadata when a package.json exists. */
  readonly pkg: PackageRecord | undefined
  /** Entrypoint picked for the requested runtime target, if one exists. */
  readonly entry: string | undefined
  /** Runtime capabilities inferred from the package metadata. */
  readonly capabilities: readonly Capability[]
  /** Validated theme manifest when the package declares `oc-themes`. */
  readonly themes: ThemeManifest | undefined
  /** Compatibility info for npm packages. */
  readonly compatibility: Compatibility | undefined
}
