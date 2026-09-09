import { create } from "@/context"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"

export interface WorkspaceContext {
  workspaceID: WorkspaceV2.ID | undefined
}

/**
 * Named context manager for the current workspace.
 * Provides async-local storage of the workspace ID.
 */
const context = create<WorkspaceContext>("workspace")

export const WorkspaceContext = {
  async provide<R>(input: { workspaceID?: WorkspaceV2.ID; fn: () => R }): Promise<R> {
    return context.provide({ workspaceID: input.workspaceID }, () => input.fn())
  },

  restore<R>(workspaceID: WorkspaceV2.ID, fn: () => R): R {
    return context.provide({ workspaceID }, fn)
  },

  get workspaceID() {
    try {
      return context.use().workspaceID
    } catch {
      return undefined
    }
  },
}
