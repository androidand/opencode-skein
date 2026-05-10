import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { zod } from "@opencode-ai/core/effect-zod"
import { withStatics } from "@opencode-ai/core/schema"

const eventPrefix = "evt"

export const EventID = Schema.String.check(Schema.isStartsWith(eventPrefix)).pipe(
  Schema.brand("EventID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending(eventPrefix, id)),
    zod: zod(s),
  })),
)
