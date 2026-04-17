import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { listAdaptors } from "../../control-plane/adaptors"
import { Workspace } from "../../control-plane/workspace"
import { Instance } from "../../project/instance"
import { WorkspaceID } from "../../control-plane/schema"
import { WorkspaceAdaptorEntry } from "../../control-plane/adaptors"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { Log } from "@/util"
import { errorData } from "@/util/error"

const log = Log.create({ service: "server.workspace" })

export const WorkspaceRoutes = lazy(() =>
  new Hono()
    .get(
      "/adaptor",
      describeRoute({
        summary: "List workspace adaptors",
        description: "List all available workspace adaptors for the current project.",
        operationId: "experimental.workspace.adaptor.list",
        responses: {
          200: {
            description: "Workspace adaptors",
            content: {
              "application/json": {
                schema: resolver(WorkspaceAdaptorEntry.zod.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await listAdaptors(Instance.project.id))
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create workspace",
        description: "Create a workspace for the current project.",
        operationId: "experimental.workspace.create",
        responses: {
          200: {
            description: "Workspace created",
            content: {
              "application/json": {
                schema: resolver(Workspace.Info.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Workspace.CreateBody.zod),
      async (c) => {
        const body = c.req.valid("json")
        const workspace = await Workspace.create({
          projectID: Instance.project.id,
          ...body,
        })
        return c.json(workspace)
      },
    )
    .get(
      "/",
      describeRoute({
        summary: "List workspaces",
        description: "List all workspaces.",
        operationId: "experimental.workspace.list",
        responses: {
          200: {
            description: "Workspaces",
            content: {
              "application/json": {
                schema: resolver(Workspace.Info.zod.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Workspace.list(Instance.project))
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Workspace status",
        description: "Get connection status for workspaces in the current project.",
        operationId: "experimental.workspace.status",
        responses: {
          200: {
            description: "Workspace status",
            content: {
              "application/json": {
                schema: resolver(Workspace.ConnectionStatus.zod.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const ids = new Set(Workspace.list(Instance.project).map((item) => item.id))
        return c.json(Workspace.status().filter((item) => ids.has(item.workspaceID)))
      },
    )
    .delete(
      "/:id",
      describeRoute({
        summary: "Remove workspace",
        description: "Remove an existing workspace.",
        operationId: "experimental.workspace.remove",
        responses: {
          200: {
            description: "Workspace removed",
            content: {
              "application/json": {
                schema: resolver(Workspace.Info.zod.optional()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          id: WorkspaceID.zod,
        }),
      ),
      async (c) => {
        const { id } = c.req.valid("param")
        return c.json(await Workspace.remove(id))
      },
    )
    .post(
      "/:id/session-restore",
      describeRoute({
        summary: "Restore session into workspace",
        description: "Replay a session's sync events into the target workspace in batches.",
        operationId: "experimental.workspace.sessionRestore",
        responses: {
          200: {
            description: "Session replay started",
            content: {
              "application/json": {
                schema: resolver(Workspace.SessionRestoreResult.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: WorkspaceID.zod })),
      validator("json", Workspace.SessionRestoreBody.zod),
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        log.info("session restore route requested", {
          workspaceID: id,
          sessionID: body.sessionID,
          directory: Instance.directory,
        })
        try {
          const result = await Workspace.sessionRestore({
            workspaceID: id,
            ...body,
          })
          log.info("session restore route complete", {
            workspaceID: id,
            sessionID: body.sessionID,
            total: result.total,
          })
          return c.json(result)
        } catch (err) {
          log.error("session restore route failed", {
            workspaceID: id,
            sessionID: body.sessionID,
            error: errorData(err),
          })
          throw err
        }
      },
    ),
)
