import { afterEach, describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Instance } from "../../src/project/instance"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function sdk(directory: string) {
  const handler = ExperimentalHttpApiServer.webHandler().handler
  return createOpencodeClient({
    baseUrl: "http://opencode.test",
    directory,
    fetch: ((input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      return handler(request, ExperimentalHttpApiServer.context)
    }) as typeof fetch,
  })
}

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

describe("HttpApi SDK", () => {
  test("serves generated SDK requests through the experimental Effect server", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Bun.write(`${tmp.path}/hello.txt`, "hello")

    const client = sdk(tmp.path)
    const file = await client.file.read({ path: "hello.txt" })
    expect(file.response.status).toBe(200)
    expect(file.data?.content).toBe("hello")

    const created = await client.session.create({ title: "sdk session" })
    if (!created.data) throw new Error("Expected session create response data")
    expect(created.response.status).toBe(200)
    expect(created.data.title).toBe("sdk session")

    const listed = await client.session.list({ roots: true, limit: 10 })
    expect(listed.response.status).toBe(200)
    expect(listed.data?.map((item) => item.id)).toContain(created.data.id)
  })
})
