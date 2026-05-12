export * as ConfigAttachment from "./attachment"

import { Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"

export const Image = Schema.Struct({
  enforce_limits: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enforce image attachment size limits before sending images to the model. When false, images pass through unchanged (default: false)",
  }),
  auto_resize: Schema.optional(Schema.Boolean).annotate({
    description:
      "Resize images before sending them to the model when they exceed configured limits. Requires enforce_limits to be true (default: false)",
  }),
  max_width: Schema.optional(PositiveInt).annotate({
    description: "Maximum image width before resizing or rejecting the attachment (default: 2000)",
  }),
  max_height: Schema.optional(PositiveInt).annotate({
    description: "Maximum image height before resizing or rejecting the attachment (default: 2000)",
  }),
  max_base64_bytes: Schema.optional(PositiveInt).annotate({
    description: "Maximum base64 payload bytes for an image attachment (default: 4718592)",
  }),
}).annotate({ identifier: "ImageAttachmentConfig" })
export type Image = Schema.Schema.Type<typeof Image>

export const Info = Schema.Struct({
  image: Schema.optional(Image).annotate({ description: "Image attachment configuration" }),
}).annotate({ identifier: "AttachmentConfig" })
export type Info = Schema.Schema.Type<typeof Info>
