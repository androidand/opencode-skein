import { Schema } from "effect"

/**
 * 404 Not Found error matching the legacy Hono `NamedError` JSON shape:
 * `{ name: "NotFoundError", data: { message } }`.
 *
 * `httpApiStatus: 404` annotation drives the response status; the schema
 * fields drive the response body. Use this in place of
 * `HttpApiError.NotFound` (which has an empty body) anywhere SDK clients
 * may inspect `error.data.message`.
 */
export class OpencodeNotFound extends Schema.ErrorClass<OpencodeNotFound>("opencode/Error/NotFound")(
  {
    name: Schema.tag("NotFoundError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  {
    description: "Not found",
    httpApiStatus: 404,
  },
) {}
