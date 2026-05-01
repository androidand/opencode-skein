import { Cause, Effect, Schema } from "effect"
import type { Interface as WorktreeService } from "@/worktree"
import { type InternalWorkspaceAdapter, WorkspaceAdapterError, WorkspaceInfo } from "../types"

const WorktreeConfig = Schema.Struct({
  name: WorkspaceInfo.fields.name,
  branch: Schema.String,
  directory: Schema.String,
})
const decodeWorktreeConfig = Schema.decodeUnknownSync(WorktreeConfig)

export const WorktreeAdapterEntry = {
  name: "Worktree",
  description: "Create a git worktree",
}

const adapterError = (message: string, cause: unknown) => new WorkspaceAdapterError({ message, cause })

const catchWorktreeError = <A, R>(effect: Effect.Effect<A, never, R>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.fail(adapterError(Cause.pretty(cause), cause)),
    ),
  )

const decodeConfig = (info: WorkspaceInfo) =>
  Effect.try({
    try: () => decodeWorktreeConfig(info),
    catch: (cause) => adapterError(cause instanceof Error ? cause.message : String(cause), cause),
  })

export function worktreeAdapter(worktree: WorktreeService): InternalWorkspaceAdapter {
  return {
    ...WorktreeAdapterEntry,
    configure(info) {
      return catchWorktreeError(
        Effect.gen(function* () {
          const next = yield* worktree.makeWorktreeInfo()
          return {
            ...info,
            name: next.name,
            branch: next.branch,
            directory: next.directory,
          }
        }),
      )
    },
    create(info) {
      return Effect.gen(function* () {
        const config = yield* decodeConfig(info)
        yield* catchWorktreeError(
          worktree.createFromInfo({
            name: config.name,
            directory: config.directory,
            branch: config.branch,
          }),
        )
      })
    },
    remove(info) {
      return Effect.gen(function* () {
        const config = yield* decodeConfig(info)
        yield* catchWorktreeError(worktree.remove({ directory: config.directory }))
      })
    },
    target(info) {
      return Effect.gen(function* () {
        const config = yield* decodeConfig(info)
        return {
          type: "local" as const,
          directory: config.directory,
        }
      })
    },
  }
}
