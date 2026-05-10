import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { zod } from "@opencode-ai/core/effect-zod"
import { withStatics } from "@opencode-ai/core/schema"

const ptyPrefix = "pty"
const ptyIdSchema = Schema.String.check(Schema.isStartsWith(ptyPrefix)).pipe(Schema.brand("PtyID"))

export type PtyID = typeof ptyIdSchema.Type

export const PtyID = ptyIdSchema.pipe(
  withStatics((schema: typeof ptyIdSchema) => ({
    ascending: (id?: string) => schema.make(Identifier.ascending(ptyPrefix, id)),
    zod: zod(schema),
  })),
)
