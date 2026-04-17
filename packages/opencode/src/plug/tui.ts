import type {
  TuiDispose,
  TuiPlugin,
  TuiPluginApi,
  TuiPluginInstallResult,
  TuiPluginMeta,
  TuiPluginModule,
  TuiPluginStatus,
} from "@opencode-ai/plugin/tui"
import type { Info as TuiConfigInfo } from "@/cli/cmd/tui/config/tui"
import type { HostPluginApi, HostSlots } from "@/cli/cmd/tui/plugin/slots"
import type { Origin, RuntimeSource } from "./spec"
import type { Fx } from "./common"
import type { ThemeEntry, TouchResult } from "./meta"

/**
 * Loaded TUI plugin before it is wrapped in runtime state.
 */
export interface PluginLoad {
  /** Inline config tuple payload forwarded to the plugin factory. */
  readonly options: Record<string, unknown> | undefined
  /** Normalized string spec. */
  readonly spec: string
  /** Resolved install target or file target. */
  readonly target: string
  /** Whether this load happened during the retry-after-dependencies pass. */
  readonly retry: boolean
  /** Whether this plugin is external or built in. */
  readonly source: RuntimeSource
  /** Stable runtime id. */
  readonly id: string
  /** Target-exclusive TUI module. */
  readonly module: TuiPluginModule
  /** Config provenance. Internal plugins still get a synthetic origin for consistency. */
  readonly origin: Origin
  /** Root used to resolve package-relative theme files. */
  readonly theme_root: string
  /** Valid theme files discovered from `oc-themes`. */
  readonly theme_files: readonly string[]
}

/**
 * One plugin-owned lifecycle scope.
 *
 * The current runtime models this manually with cleanup functions and an `AbortController`.
 */
export interface PluginScope {
  /** Lifecycle object exposed to the plugin API. */
  readonly lifecycle: TuiPluginApi["lifecycle"]
  /** Register a plain cleanup callback and return an unregister function. */
  readonly track: (fn: TuiDispose | undefined) => () => void
  /** Dispose the scope and run cleanup callbacks in reverse order. */
  readonly dispose: () => Promise<void>
}

/**
 * One plugin entry tracked by the TUI manager.
 */
export interface PluginEntry {
  /** Stable runtime id. */
  readonly id: string
  /** Raw load details used for diagnostics and reload decisions. */
  readonly load: PluginLoad
  /** Metadata exposed to plugin code and the UI. */
  readonly meta: TuiPluginMeta
  /** Persisted theme install records keyed by theme name. */
  readonly themes: Readonly<Record<string, ThemeEntry>>
  /** Concrete TUI plugin factory. */
  readonly plugin: TuiPlugin
  /** Current enabled state. */
  readonly enabled: boolean
  /** Live lifecycle scope when the plugin is active. */
  readonly scope: PluginScope | undefined
}

/**
 * Result of running one plugin cleanup callback.
 */
export type CleanupResult =
  | { readonly type: "ok" }
  | { readonly type: "error"; readonly error: unknown }
  | { readonly type: "timeout" }

/**
 * Stateful data owned by the TUI plugin manager.
 */
export interface State {
  /** Current directory the runtime was initialized for. */
  readonly directory: string
  /** Host-side API exposed to plugins. */
  readonly api: HostPluginApi
  /** Slot registry used by TUI plugins. */
  readonly slots: HostSlots
  /** Ordered plugin list used for activation, disposal, and status display. */
  readonly plugins: readonly PluginEntry[]
  /** Fast lookup by plugin id. */
  readonly plugins_by_id: ReadonlyMap<string, PluginEntry>
  /** Newly installed plugin origins waiting to be added to the live runtime. */
  readonly pending: ReadonlyMap<string, Origin>
}

/**
 * Result of tracking newly loaded external plugins in the metadata store.
 */
export interface MetadataBatch {
  /** Metadata touch results in the same order as the loaded plugins. */
  readonly results: readonly TouchResult[]
}

/**
 * Public service surface for the TUI plugin runtime.
 *
 * This would replace the current module-global singleton state with an explicit service.
 */
export interface Interface {
  /** Initialize the runtime for one working directory and config snapshot. */
  readonly init: (input: { api: HostPluginApi; config: TuiConfigInfo }) => Fx<void>
  /** Return current status rows for the TUI plugin UI. */
  readonly list: () => Fx<readonly TuiPluginStatus[]>
  /** Enable one plugin id. */
  readonly activate: (id: string) => Fx<boolean>
  /** Disable one plugin id. */
  readonly deactivate: (id: string) => Fx<boolean>
  /** Add one already-configured plugin spec to the live runtime. */
  readonly add: (spec: string) => Fx<boolean>
  /** Install a package and patch config, returning the current TUI-facing result type. */
  readonly install: (spec: string, options: { global?: boolean } | undefined) => Fx<TuiPluginInstallResult>
  /** Dispose all active plugins in reverse order. */
  readonly dispose: () => Fx<void>
}

/**
 * Stateless helper signature for creating one active plugin scope.
 */
export type CreateScope = (input: { load: PluginLoad; id: string; disposeTimeoutMs: number }) => PluginScope

/**
 * Stateless helper signature for activating one plugin entry.
 */
export type ActivateEntry = (input: {
  state: State
  plugin: PluginEntry
  persist: boolean
}) => Fx<boolean>

/**
 * Stateless helper signature for deactivating one plugin entry.
 */
export type DeactivateEntry = (input: {
  state: State
  plugin: PluginEntry
  persist: boolean
}) => Fx<boolean>

/**
 * Stateless helper signature for syncing theme files for one plugin entry.
 */
export type SyncThemes = (plugin: PluginEntry) => Fx<void>
