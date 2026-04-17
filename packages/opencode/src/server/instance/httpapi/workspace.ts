import { listAdaptors, WorkspaceAdaptorEntry } from "@/control-plane/adaptors"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceID } from "@/control-plane/schema"
import { Instance } from "@/project/instance"
import { Effect, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

const root = "/experimental/workspace"

export const WorkspaceApi = HttpApi.make("workspace")
  .add(
    HttpApiGroup.make("workspace")
      .add(
        HttpApiEndpoint.get("adaptors", `${root}/adaptor`, {
          success: Schema.Array(WorkspaceAdaptorEntry),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.adaptor.list",
            summary: "List workspace adaptors",
            description: "List all available workspace adaptors for the current project.",
          }),
        ),
        HttpApiEndpoint.get("list", root, {
          success: Schema.Array(Workspace.Info),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.list",
            summary: "List workspaces",
            description: "List all workspaces.",
          }),
        ),
        HttpApiEndpoint.get("status", `${root}/status`, {
          success: Schema.Array(Workspace.ConnectionStatus),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.status",
            summary: "Workspace status",
            description: "Get connection status for workspaces in the current project.",
          }),
        ),
        HttpApiEndpoint.post("create", root, {
          payload: Workspace.CreateBody,
          success: Workspace.Info,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.create",
            summary: "Create workspace",
            description: "Create a workspace for the current project.",
          }),
        ),
        HttpApiEndpoint.delete("remove", `${root}/:id`, {
          params: { id: WorkspaceID },
          success: Schema.optional(Workspace.Info),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.remove",
            summary: "Remove workspace",
            description: "Remove an existing workspace.",
          }),
        ),
        HttpApiEndpoint.post("sessionRestore", `${root}/:id/session-restore`, {
          params: { id: WorkspaceID },
          payload: Workspace.SessionRestoreBody,
          success: Workspace.SessionRestoreResult,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.sessionRestore",
            summary: "Restore session into workspace",
            description: "Replay a session's sync events into the target workspace in batches.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "workspace",
          description: "Experimental HttpApi workspace routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )

const adaptors = Effect.fn("WorkspaceHttpApi.adaptors")(function* () {
  return yield* Effect.promise(() => listAdaptors(Instance.project.id))
})

const list = Effect.fn("WorkspaceHttpApi.list")(function* () {
  return Workspace.list(Instance.project)
})

const status = Effect.fn("WorkspaceHttpApi.status")(function* () {
  const ids = new Set(Workspace.list(Instance.project).map((item) => item.id))
  return Workspace.status().filter((item) => ids.has(item.workspaceID))
})

const create = Effect.fn("WorkspaceHttpApi.create")(function* (ctx: { payload: Workspace.CreateBody }) {
  return yield* Effect.promise(() =>
    Workspace.create({
      projectID: Instance.project.id,
      ...ctx.payload,
    }),
  ).pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
})

const remove = Effect.fn("WorkspaceHttpApi.remove")(function* (ctx: { params: { id: WorkspaceID } }) {
  return yield* Effect.promise(() => Workspace.remove(ctx.params.id)).pipe(
    Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))),
  )
})

const sessionRestore = Effect.fn("WorkspaceHttpApi.sessionRestore")(function* (ctx: {
  params: { id: WorkspaceID }
  payload: Workspace.SessionRestoreBody
}) {
  return yield* Effect.promise(() =>
    Workspace.sessionRestore({
      workspaceID: ctx.params.id,
      sessionID: ctx.payload.sessionID,
    }),
  ).pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
})

export const workspaceHandlers = HttpApiBuilder.group(WorkspaceApi, "workspace", (handlers) =>
  handlers
    .handle("adaptors", adaptors)
    .handle("list", list)
    .handle("status", status)
    .handle("create", create)
    .handle("remove", remove)
    .handle("sessionRestore", sessionRestore),
)
