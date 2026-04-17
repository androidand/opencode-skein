import type { Fx } from "./common"

/**
 * External sources tracked in the metadata file.
 *
 * Internal plugins are intentionally excluded because the metadata file is for user-configurable external plugins.
 */
export type Source = "file" | "npm"

/**
 * Persisted information about one installed theme file provided by a TUI plugin.
 */
export interface ThemeEntry {
  /** Original theme file inside the plugin package or local plugin root. */
  readonly src: string
  /** Final persisted destination in the user's themes directory. */
  readonly dest: string
  /** Source file modification time used to detect changes. */
  readonly mtime: number | undefined
  /** Source file size used to detect changes. */
  readonly size: number | undefined
}

/**
 * Persisted metadata about one external plugin id.
 */
export interface Entry {
  /** Logical runtime id. */
  readonly id: string
  /** Whether this record describes a file plugin or npm plugin. */
  readonly source: Source
  /** Normalized config spec that produced the record. */
  readonly spec: string
  /** Resolved install directory or file target. */
  readonly target: string
  /** Requested npm version or range from the original spec, when relevant. */
  readonly requested: string | undefined
  /** Installed package version, when relevant. */
  readonly version: string | undefined
  /** Modified time for local file plugins, when relevant. */
  readonly modified: number | undefined
  /** First time this plugin id was seen. */
  readonly first_time: number
  /** Most recent time this plugin id was loaded. */
  readonly last_time: number
  /** Most recent time the record fingerprint changed. */
  readonly time_changed: number
  /** Number of times the plugin has been loaded. */
  readonly load_count: number
  /** Compact identity used to decide whether the plugin changed between runs. */
  readonly fingerprint: string
  /** Theme files installed on behalf of this plugin. */
  readonly themes: Readonly<Record<string, ThemeEntry>> | undefined
}

/**
 * How the latest touch compared with the previously persisted record.
 */
export type TouchState = "first" | "updated" | "same"

/**
 * Input required to update metadata for one external plugin load.
 */
export interface TouchInput {
  /** Normalized config spec. */
  readonly spec: string
  /** Resolved install target or file target. */
  readonly target: string
  /** Logical runtime id. */
  readonly id: string
}

/**
 * Result returned after updating metadata for one plugin.
 */
export interface TouchResult {
  /** Whether the plugin is new, changed, or unchanged compared with the previous record. */
  readonly state: TouchState
  /** The full persisted entry after the update. */
  readonly entry: Entry
}

/**
 * Entire on-disk metadata store keyed by runtime plugin id.
 */
export type Store = Readonly<Record<string, Entry>>

/**
 * Stateful service responsible for the plugin metadata file.
 *
 * This is a strong service boundary because it owns a lock, persistence format, and mutation rules.
 */
export interface Interface {
  /** Update metadata for one plugin load. */
  readonly touch: (input: TouchInput) => Fx<TouchResult>
  /** Update metadata for many plugin loads in a single locked write. */
  readonly touchMany: (input: readonly TouchInput[]) => Fx<readonly TouchResult[]>
  /** Persist one installed theme record under an existing plugin id. */
  readonly setTheme: (input: { id: string; name: string; theme: ThemeEntry }) => Fx<void>
  /** Read the entire current metadata store. */
  readonly list: () => Fx<Store>
}
