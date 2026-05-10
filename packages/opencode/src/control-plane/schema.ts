import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { zod } from "@opencode-ai/core/effect-zod"
import { withStatics } from "@opencode-ai/core/schema"

const workspacePrefix = "wrk"
const workspaceIdSchema = Schema.String.check(Schema.isStartsWith(workspacePrefix)).pipe(Schema.brand("WorkspaceID"))

export type WorkspaceID = typeof workspaceIdSchema.Type

export const WorkspaceID = workspaceIdSchema.pipe(
  withStatics((schema: typeof workspaceIdSchema) => ({
    ascending: (id?: string) => schema.make(Identifier.ascending(workspacePrefix, id)),
    zod: zod(schema),
  })),
)
