import type { ProjectID } from "@/project/schema"
import { Effect, Schema } from "effect"
import type { WorkspaceAdapter as PluginWorkspaceAdapter, WorkspaceInfo as PluginWorkspaceInfo } from "@opencode-ai/plugin"
import { EffectBridge } from "@/effect/bridge"
import { errorMessage } from "@/util/error"
import { type InternalWorkspaceAdapter, WorkspaceAdapterError, type WorkspaceAdapterEntry, WorkspaceInfo } from "../types"
import type { Interface as WorktreeService } from "@/worktree"
import { WorktreeAdapterEntry, worktreeAdapter } from "./worktree"

const BUILTIN: WorkspaceAdapterEntry[] = [{ type: "worktree", ...WorktreeAdapterEntry }]

export const makeBuiltinAdapters = (worktree: WorktreeService) =>
  new Map<string, InternalWorkspaceAdapter>([["worktree", worktreeAdapter(worktree)]])

const plugins = new Map<ProjectID, Map<string, InternalWorkspaceAdapter>>()
const emptyBuiltinAdapters = new Map<string, InternalWorkspaceAdapter>()

export function getAdapter(
  projectID: ProjectID,
  type: string,
  builtin: ReadonlyMap<string, InternalWorkspaceAdapter> = emptyBuiltinAdapters,
): InternalWorkspaceAdapter {
  const custom = plugins.get(projectID)?.get(type)
  if (custom) return custom

  const adapter = builtin.get(type)
  if (adapter) return adapter

  throw new Error(`Unknown workspace adapter: ${type}`)
}

export async function listAdapters(projectID: ProjectID): Promise<WorkspaceAdapterEntry[]> {
  const custom = [...(plugins.get(projectID)?.entries() ?? [])].map(([type, adapter]) => ({
    type,
    name: adapter.name,
    description: adapter.description,
  }))
  return [...BUILTIN, ...custom]
}

const adapterError = (cause: unknown) => new WorkspaceAdapterError({ message: errorMessage(cause), cause })
const decodeInfo = (value: PluginWorkspaceInfo) =>
  Schema.decodeEffect(WorkspaceInfo)(value).pipe(Effect.mapError(adapterError))

function runPromiseAdapter<A>(fn: () => A | Promise<A>) {
  return Effect.gen(function* () {
    const bridge = yield* EffectBridge.make()
    return yield* bridge.run(Effect.tryPromise({
      try: () => Promise.resolve().then(fn),
      catch: adapterError,
    }))
  })
}

function fromPromiseAdapter(adapter: PluginWorkspaceAdapter): InternalWorkspaceAdapter {
  return {
    name: adapter.name,
    description: adapter.description,
    configure: (info) => runPromiseAdapter(() => adapter.configure(info)).pipe(Effect.flatMap(decodeInfo)),
    create: (info, env, from) => runPromiseAdapter(() => adapter.create(info, env, from)),
    remove: (info) => runPromiseAdapter(() => adapter.remove(info)),
    target: (info) => runPromiseAdapter(() => adapter.target(info)),
  }
}

export function registerAdapter(projectID: ProjectID, type: string, adapter: PluginWorkspaceAdapter) {
  // Plugins can be loaded per-project so we need to scope them. If you
  // want to install a global one pass `ProjectID.global`.
  const adapters = plugins.get(projectID) ?? new Map<string, InternalWorkspaceAdapter>()
  adapters.set(type, fromPromiseAdapter(adapter))
  plugins.set(projectID, adapters)
}
