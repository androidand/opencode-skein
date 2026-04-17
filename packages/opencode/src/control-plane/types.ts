import z from "zod"
import { Schema } from "effect"
import { ProjectID } from "@/project/schema"
import { WorkspaceID } from "./schema"

const WorkspaceInfoZod = z
  .object({
    id: WorkspaceID.zod,
    type: z.string(),
    name: z.string(),
    branch: z.string().nullable(),
    directory: z.string().nullable(),
    extra: z.unknown().nullable(),
    projectID: ProjectID.zod,
  })
  .meta({
    ref: "Workspace",
  })

const _WorkspaceInfo = Schema.Struct({
  id: WorkspaceID,
  type: Schema.String,
  name: Schema.String,
  branch: Schema.NullOr(Schema.String),
  directory: Schema.NullOr(Schema.String),
  extra: Schema.NullOr(Schema.Unknown),
  projectID: ProjectID,
}).annotate({ identifier: "Workspace" })

export const WorkspaceInfo = Object.assign(_WorkspaceInfo, { zod: WorkspaceInfoZod })
export type WorkspaceInfo = Schema.Schema.Type<typeof _WorkspaceInfo>

export type Target =
  | {
      type: "local"
      directory: string
    }
  | {
      type: "remote"
      url: string | URL
      headers?: HeadersInit
    }

export type WorkspaceAdaptor = {
  name: string
  description: string
  configure(info: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>
  create(info: WorkspaceInfo, env: Record<string, string>, from?: WorkspaceInfo): Promise<void>
  remove(info: WorkspaceInfo): Promise<void>
  target(info: WorkspaceInfo): Target | Promise<Target>
}
