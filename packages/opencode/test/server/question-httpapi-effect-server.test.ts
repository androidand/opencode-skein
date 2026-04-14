import { afterEach, describe, expect, test } from "bun:test"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Question } from "../../src/question"
import { Server } from "../../src/server/server"
import { ExperimentalHttpApiServer } from "../../src/server/instance/httpapi/server"
import { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const ask = (input: { sessionID: SessionID; questions: ReadonlyArray<Question.Info> }) =>
  AppRuntime.runPromise(Question.Service.use((svc) => svc.ask(input)))

afterEach(async () => {
  await Instance.disposeAll()
})

describe("experimental question effect httpapi server", () => {
  test("serves the question slice directly over effect http", async () => {
    await using tmp = await tmpdir({ git: true })
    const server = await ExperimentalHttpApiServer.listen({ hostname: "127.0.0.1", port: 0 })
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": tmp.path,
    }
    const questions: ReadonlyArray<Question.Info> = [
      {
        question: "What would you like to do?",
        header: "Action",
        options: [
          { label: "Option 1", description: "First option" },
          { label: "Option 2", description: "Second option" },
        ],
      },
    ]

    let pending!: ReturnType<typeof ask>

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        pending = ask({
          sessionID: SessionID.make("ses_test"),
          questions,
        })
      },
    })

    try {
      const list = await fetch(`${server.url}/experimental/httpapi/question`, { headers })
      expect(list.status).toBe(200)
      const items = await list.json()
      expect(items).toHaveLength(1)

      const doc = await fetch(`${server.url}/experimental/httpapi/question/doc`, { headers })
      expect(doc.status).toBe(200)
      const spec = await doc.json()
      expect(spec.paths["/experimental/httpapi/question"]?.get?.operationId).toBe("question.list")

      const reply = await fetch(`${server.url}/experimental/httpapi/question/${items[0].id}/reply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ answers: [["Option 1"]] }),
      })
      expect(reply.status).toBe(200)
      expect(await pending).toEqual([["Option 1"]])
    } finally {
      await server.stop()
    }
  })
})
