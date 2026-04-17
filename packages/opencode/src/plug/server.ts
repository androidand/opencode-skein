import type { Hooks, Plugin as ServerPluginFactory, PluginInput } from "@opencode-ai/plugin"
import type { Fx } from "./common"
import type { Loaded } from "./external"
import type { Source } from "./spec"

/**
 * Built-in server plugin that ships with the app and does not go through the external loader.
 */
export interface InternalPlugin {
  /** Stable id used for diagnostics and duplicate detection. */
  readonly id: string
  /** Factory that creates one `Hooks` object when the plugin service starts. */
  readonly plugin: ServerPluginFactory
}

/**
 * One successfully instantiated server plugin hook set.
 */
export interface HookEntry {
  /** Stable runtime id. */
  readonly id: string
  /** Normalized spec that produced this hook set. */
  readonly spec: string
  /** Whether the plugin came from npm, a file path, or built-in code. */
  readonly source: Source | "internal"
  /** Hook handlers returned by the plugin factory. */
  readonly hooks: Hooks
}

/**
 * Stateful data owned by the server plugin runtime per project/worktree instance.
 */
export interface State {
  /** Fully initialized hook sets in the order they should run. */
  readonly loaded: readonly HookEntry[]
  /** Flat hook list kept for the existing trigger API. */
  readonly hooks: readonly Hooks[]
}

/**
 * Hook names that follow the trigger pattern `(input, output) => Promise<void>`.
 */
export type TriggerName = {
  [Name in keyof Hooks]-?: NonNullable<Hooks[Name]> extends (input: infer _Input, output: infer _Output) => Promise<void>
    ? Name
    : never
}[keyof Hooks]

/**
 * Input type for one triggerable hook name.
 */
export type TriggerInput<Name extends TriggerName> = Parameters<Required<Hooks>[Name]>[0]

/**
 * Output accumulator type for one triggerable hook name.
 */
export type TriggerOutput<Name extends TriggerName> = Parameters<Required<Hooks>[Name]>[1]

/**
 * Context assembled before any server plugins are instantiated.
 */
export interface RuntimeContext {
  /** Rich plugin input passed to every server plugin factory. */
  readonly input: PluginInput
  /** Whether external plugins should be skipped because the runtime is in pure mode. */
  readonly pure: boolean
}

/**
 * Stateless adapter that turns a loaded external module into one or more server hook sets.
 *
 * The return type is plural because legacy server modules can still expose multiple plugin factories.
 */
export type ApplyLoaded = (load: Loaded, input: PluginInput) => Fx<readonly Hooks[]>

/**
 * Public service surface for the server plugin runtime.
 *
 * The implementation would be backed by `InstanceState` because loaded hooks and bus subscriptions are
 * scoped to one project/worktree instance.
 */
export interface Interface {
  /** Ensure the per-instance plugin state has been initialized. */
  readonly init: () => Fx<void>
  /** Return the currently loaded hook objects. */
  readonly list: () => Fx<readonly Hooks[]>
  /** Trigger one hook name across loaded plugins while preserving plugin order. */
  readonly trigger: <Name extends TriggerName>(
    name: Name,
    input: TriggerInput<Name>,
    output: TriggerOutput<Name>,
  ) => Fx<TriggerOutput<Name>>
}
