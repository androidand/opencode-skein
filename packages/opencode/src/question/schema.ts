import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { zod } from "@opencode-ai/core/effect-zod"
import { Newtype } from "@opencode-ai/core/schema"

const questionPrefix = "que"

export class QuestionID extends Newtype<QuestionID>()(
  "QuestionID",
  Schema.String.check(Schema.isStartsWith(questionPrefix)),
) {
  static ascending(id?: string): QuestionID {
    return this.make(Identifier.ascending(questionPrefix, id))
  }

  static readonly zod = zod(this)
}
