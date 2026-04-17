import type { Origin } from "./spec"
import type { Failure, Fx, Ok } from "./common"

/**
 * How a config patch changed one file.
 */
export type PatchMode = "noop" | "add" | "replace"

/**
 * Why a package is considered to target one runtime.
 */
export type TargetReason = "server-export" | "tui-export" | "package-main" | "themes"

/**
 * One runtime target inferred from an installed package.
 */
export interface Target {
  /** Which runtime should receive a config entry. */
  readonly kind: "server" | "tui"
  /** Optional default options to write alongside the plugin spec. */
  readonly options: Record<string, unknown> | undefined
  /** Why this runtime target was inferred from package metadata. */
  readonly reason: TargetReason
}

/**
 * High-level package manifest summary returned by plugin inspection.
 */
export interface Manifest {
  /** Installed or resolved target used to inspect the package. */
  readonly target: string
  /** Runtime targets inferred from that package. */
  readonly targets: readonly Target[]
}

/**
 * Context needed when patching config files after install.
 */
export interface PatchRequest {
  /** Plugin spec to add or replace. */
  readonly spec: string
  /** Runtime targets that should be written into config. */
  readonly targets: readonly Target[]
  /** Whether an existing npm package entry may be replaced by package name. */
  readonly force: boolean
  /** Whether the write should go to the global config directory. */
  readonly global: boolean
  /** VCS hint used to decide whether the worktree root should own the local config write. */
  readonly vcs: string | undefined
  /** Current worktree path. */
  readonly worktree: string
  /** Current working directory. */
  readonly directory: string
  /** Optional explicit global config directory override. */
  readonly config: string | undefined
}

/**
 * One config file mutation performed during patching.
 */
export interface PatchItem {
  /** Which runtime file was touched. */
  readonly kind: "server" | "tui"
  /** Whether the plugin row was added, replaced, or already present. */
  readonly mode: PatchMode
  /** Concrete config file path that was inspected or written. */
  readonly file: string
}

/**
 * Final result of a successful config patch operation.
 */
export interface PatchSuccess {
  /** Directory that owned the config write. */
  readonly dir: string
  /** Per-runtime write details. */
  readonly items: readonly PatchItem[]
}

/**
 * Shared error union for install and config patch workflows.
 */
export type InstallFailure =
  | Failure<"install_failed", { error: unknown }>
  | Failure<"manifest_read_failed", { file: string; error: unknown }>
  | Failure<"manifest_no_targets", { file: string }>
  | Failure<"invalid_json", { kind: "server" | "tui"; file: string; line: number; col: number; parse: string }>
  | Failure<"patch_failed", { kind: "server" | "tui"; error: unknown }>

/**
 * Current low-level install result shape.
 */
export type InstallResult = Ok<{ target: string }>

/**
 * Current low-level manifest inspection result shape.
 */
export type ManifestResult = Ok<{ manifest: Manifest }> | InstallFailure

/**
 * Current low-level patch result shape.
 */
export type PatchResult = Ok<PatchSuccess> | InstallFailure

/**
 * High-level request for the full install-and-configure workflow.
 */
export interface InstallAndConfigureRequest {
  /** Raw package spec entered by the user. */
  readonly spec: string
  /** Whether the installed plugin should be written to global config. */
  readonly global: boolean
  /** Whether an already-configured npm package may be replaced by package name. */
  readonly force: boolean
  /** Current working directory. */
  readonly directory: string
  /** Current worktree root. */
  readonly worktree: string
  /** VCS hint used when picking the local config directory. */
  readonly vcs: string | undefined
  /** Optional explicit global config directory override. */
  readonly config: string | undefined
}

/**
 * Result of the full install-and-configure workflow.
 *
 * The optional `origin` field is useful for the TUI runtime, which wants to track newly configured
 * plugins before they are actually activated.
 */
export interface InstallAndConfigureSuccess {
  /** Resolved install target returned by the package install step. */
  readonly target: string
  /** Inferred package manifest. */
  readonly manifest: Manifest
  /** Config patch details. */
  readonly patch: PatchSuccess
  /** Newly configured TUI origin when the package exposed a TUI target. */
  readonly origin: Origin | undefined
}

/**
 * Intended shared workflow used by both `opencode plug` and the TUI runtime.
 */
export type InstallAndConfigure = (
  request: InstallAndConfigureRequest,
) => Fx<InstallAndConfigureSuccess, InstallFailure>
