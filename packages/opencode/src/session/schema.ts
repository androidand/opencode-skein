import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { zod } from "@opencode-ai/core/effect-zod"
import { withStatics } from "@opencode-ai/core/schema"

const sessionPrefix = "ses"
const messagePrefix = "msg"
const partPrefix = "prt"

export const SessionID = Schema.String.check(Schema.isStartsWith(sessionPrefix)).pipe(
  Schema.brand("SessionID"),
  withStatics((s) => ({
    descending: (id?: string) => s.make(Identifier.descending(sessionPrefix, id)),
    zod: zod(s),
  })),
)

export type SessionID = Schema.Schema.Type<typeof SessionID>

export const MessageID = Schema.String.check(Schema.isStartsWith(messagePrefix)).pipe(
  Schema.brand("MessageID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending(messagePrefix, id)),
    zod: zod(s),
  })),
)

export type MessageID = Schema.Schema.Type<typeof MessageID>

export const PartID = Schema.String.check(Schema.isStartsWith(partPrefix)).pipe(
  Schema.brand("PartID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending(partPrefix, id)),
    zod: zod(s),
  })),
)

export type PartID = Schema.Schema.Type<typeof PartID>
