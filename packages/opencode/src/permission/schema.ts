import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { zod } from "@opencode-ai/core/effect-zod"
import { Newtype } from "@opencode-ai/core/schema"

const permissionPrefix = "per"

export class PermissionID extends Newtype<PermissionID>()(
  "PermissionID",
  Schema.String.check(Schema.isStartsWith(permissionPrefix)),
) {
  static ascending(id?: string): PermissionID {
    return this.make(Identifier.ascending(permissionPrefix, id))
  }

  static readonly zod = zod(this)
}
