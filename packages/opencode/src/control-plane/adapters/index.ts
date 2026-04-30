import { lazy } from "@/util/lazy"
import type { ProjectID } from "@/project/schema"
import type { WorkspaceAdapter, WorkspaceAdapterEntry } from "../types"

const BUILTIN: Record<string, () => Promise<WorkspaceAdapter>> = {
  worktree: lazy(async () => (await import("./worktree")).WorktreeAdapter),
}

const state = new Map<ProjectID, Map<string, WorkspaceAdapter>>()

export async function getAdapter(projectID: ProjectID, type: string): Promise<WorkspaceAdapter> {
  const custom = state.get(projectID)?.get(type)
  if (custom) return custom

  const builtin = BUILTIN[type]
  if (builtin) return builtin()

  throw new Error(`Unknown workspace adapter: ${type}`)
}

export async function listAdapters(projectID: ProjectID): Promise<WorkspaceAdapterEntry[]> {
  const builtin = await Promise.all(
    Object.entries(BUILTIN).map(async ([type, init]) => {
      const adapter = await init()
      return {
        type,
        name: adapter.name,
        description: adapter.description,
      }
    }),
  )
  const custom = [...(state.get(projectID)?.entries() ?? [])].map(([type, adapter]) => ({
    type,
    name: adapter.name,
    description: adapter.description,
  }))
  return [...builtin, ...custom]
}

// Plugins can be loaded per-project so we need to scope them. If you
// want to install a global one pass `ProjectID.global`
export function registerAdapter(projectID: ProjectID, type: string, adapter: WorkspaceAdapter) {
  const adapters = state.get(projectID) ?? new Map<string, WorkspaceAdapter>()
  adapters.set(type, adapter)
  state.set(projectID, adapters)
}
