import type {
  Options as ConfigPluginOptions,
  Origin as ConfigPluginOrigin,
  Scope as ConfigPluginScope,
  Spec as ConfigPluginSpec,
} from "@/config/plugin"

/**
 * The two external plugin sources supported by the current system.
 *
 * `file` means a local path or `file://` URL.
 * `npm` means an installable package spec.
 */
export type Source = "file" | "npm"

/**
 * `internal` is used by the TUI runtime for built-in plugins that are shipped with the app.
 *
 * It is kept separate from `Source` because it is not part of the external plugin loading pipeline.
 */
export type RuntimeSource = Source | "internal"

/**
 * The two runtime targets a package can expose.
 */
export type Kind = "server" | "tui"

/**
 * Inline config tuple options forwarded to the plugin factory.
 */
export type Options = ConfigPluginOptions

/**
 * Raw plugin config entry as it appears in `opencode.json` or `tui.json`.
 */
export type Input = ConfigPluginSpec

/**
 * Config provenance attached to a plugin declaration after config merging.
 *
 * This answers "which config file declared this plugin?" so follow-up writes can go back to the
 * right place.
 */
export type Origin = ConfigPluginOrigin

/**
 * Whether a config origin should behave like a global or project-local plugin declaration.
 */
export type Scope = ConfigPluginScope

/**
 * Parsed npm-style package identity.
 *
 * This is the identity used for dedupe and for better install error messages.
 */
export interface ParsedSpecifier {
  /** Package name portion of the spec. For file specs this will usually just be the original string. */
  readonly pkg: string
  /** Version request portion of the spec. Bare package names typically normalize to `latest`. */
  readonly version: string
}

/**
 * Normalized external plugin declaration.
 *
 * This is the shape that downstream loading code should work with instead of raw config tuples.
 */
export interface Declared {
  /** Original config provenance. */
  readonly origin: Origin
  /** Normalized string spec extracted from the raw config value. */
  readonly spec: string
  /** Optional config tuple payload that should be forwarded to the plugin factory. */
  readonly options: Options | undefined
  /** Whether this should be treated as a file plugin or npm plugin. */
  readonly source: Source
  /** Whether the package name maps to a built-in plugin and should therefore be ignored. */
  readonly deprecated: boolean
}

/**
 * Candidate item passed into the external load pipeline.
 *
 * The name exists to make it obvious that the plugin has not been resolved or imported yet.
 */
export interface Candidate {
  /** Original config entry and provenance. */
  readonly origin: Origin
  /** Normalized declaration derived from that config entry. */
  readonly declared: Declared
}
