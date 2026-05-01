import { listAdaptors } from "@/control-plane/adaptors"
import { Workspace } from "@/control-plane/workspace"
import * as InstanceState from "@/effect/instance-state"
import { Instance } from "@/project/instance"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { CreatePayload, WarpPayload } from "../groups/workspace"

export const workspaceHandlers = HttpApiBuilder.group(InstanceHttpApi, "workspace", (handlers) =>
  Effect.gen(function* () {
    const adaptors = Effect.fn("WorkspaceHttpApi.adaptors")(function* () {
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() => listAdaptors(instance.project.id))
    })

    const list = Effect.fn("WorkspaceHttpApi.list")(function* () {
      return Workspace.list((yield* InstanceState.context).project)
    })

    const create = Effect.fn("WorkspaceHttpApi.create")(function* (ctx: { payload: typeof CreatePayload.Type }) {
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() =>
        Instance.restore(instance, () =>
          Workspace.create({
            ...ctx.payload,
            projectID: instance.project.id,
          }),
        ),
      )
    })

    const status = Effect.fn("WorkspaceHttpApi.status")(function* () {
      const ids = new Set(Workspace.list((yield* InstanceState.context).project).map((item) => item.id))
      return Workspace.status().filter((item) => ids.has(item.workspaceID))
    })

    const remove = Effect.fn("WorkspaceHttpApi.remove")(function* (ctx: { params: { id: Workspace.Info["id"] } }) {
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() => Instance.restore(instance, () => Workspace.remove(ctx.params.id)))
    })

    const warp = Effect.fn("WorkspaceHttpApi.warp")(function* (ctx: {
      params: { id: Workspace.Info["id"] }
      payload: typeof WarpPayload.Type
    }) {
      const instance = yield* InstanceState.context
      yield* Effect.promise(() =>
        Instance.restore(instance, () =>
          Workspace.sessionWarp({
            workspaceID: ctx.params.id,
            ...ctx.payload,
          }),
        ),
      )
      return HttpApiSchema.NoContent.make()
    })

    return handlers
      .handle("adaptors", adaptors)
      .handle("list", list)
      .handle("create", create)
      .handle("status", status)
      .handle("remove", remove)
      .handle("warp", warp)
  }),
)
