import { AppLayer } from "@/effect/app-runtime"
import { memoMap } from "@/effect/run-service"
import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { makeQuestionHandler, makeQuestionWebHandler } from "@opencode-ai/server"
import { Effect, Layer } from "effect"
import type { Handler } from "hono"

const QuestionLive = makeQuestionHandler({
  list: Effect.fn("QuestionHttpApi.host.list")(function* () {
    const svc = yield* Question.Service
    return yield* svc.list()
  }),
  reply: Effect.fn("QuestionHttpApi.host.reply")(function* (input) {
    const svc = yield* Question.Service
    yield* svc.reply({
      requestID: QuestionID.make(input.requestID),
      answers: input.answers,
    })
  }),
}).pipe(Layer.provide(Question.defaultLayer))

const web = makeQuestionWebHandler({
  app: AppLayer,
  live: QuestionLive,
  memoMap,
})

export const QuestionHttpApiHandler: Handler = (c, _next) => web(c.req.raw)
