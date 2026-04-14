import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

describe("question openapi", () => {
  test("keeps the public reply body inline", async () => {
    const spec = await Server.openapi()
    const body = spec.paths["/question/{requestID}/reply"]?.post?.requestBody

    expect(body).toBeDefined()
    if (!body || "$ref" in body) throw new Error("expected inline request body")

    const media = body.content["application/json"]
    expect(media).toBeDefined()
    if (!media || "$ref" in media) throw new Error("expected inline json media type")

    expect(media.schema).toMatchObject({
      type: "object",
      required: ["answers"],
      properties: {
        answers: {
          description: "User answers in order of questions (each answer is an array of selected labels)",
          type: "array",
          items: {
            $ref: "#/components/schemas/QuestionAnswer",
          },
        },
      },
    })
  })
})
