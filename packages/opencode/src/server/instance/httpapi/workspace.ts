import { listAdaptors, WorkspaceAdaptorEntry } from "@/control-plane/adaptors"
import { Workspace } from "@/control-plane/workspace"
import { Instance } from "@/project/instance"
import { Effect, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

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

export const workspaceHandlers = HttpApiBuilder.group(WorkspaceApi, "workspace", (handlers) =>
  handlers.handle("adaptors", adaptors).handle("list", list).handle("status", status),
)
