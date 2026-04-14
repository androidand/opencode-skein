import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { QuestionReply, QuestionRequest, questionApi, questionRoot } from "../definition/question.js"

export interface QuestionOps<R = never> {
  readonly list: () => Effect.Effect<ReadonlyArray<unknown>, never, R>
  readonly reply: (input: {
    requestID: string
    answers: Schema.Schema.Type<typeof QuestionReply>["answers"]
  }) => Effect.Effect<void, never, R>
}

export const makeQuestionHandler = <R>(ops: QuestionOps<R>) =>
  HttpApiBuilder.group(
    questionApi,
    "question",
    Effect.fn("QuestionHttpApi.handlers")(function* (handlers) {
      const decode = Schema.decodeUnknownSync(Schema.Array(QuestionRequest))

      const list = Effect.fn("QuestionHttpApi.list")(function* () {
        return decode(yield* ops.list())
      })

      const reply = Effect.fn("QuestionHttpApi.reply")(function* (ctx: {
        params: { requestID: string }
        payload: Schema.Schema.Type<typeof QuestionReply>
      }) {
        yield* ops.reply({
          requestID: ctx.params.requestID,
          answers: ctx.payload.answers,
        })
        return true
      })

      return handlers.handle("list", list).handle("reply", reply)
    }),
  )

export const makeQuestionWebHandler = <A, E, R, B, F, S>(opts: {
  readonly app: Layer.Layer<A, E, R>
  readonly live: Layer.Layer<B, F, S>
  readonly memoMap?: Layer.MemoMap
}) => {
  const app = Layer.mergeAll(
    opts.app,
    HttpApiBuilder.layer(questionApi, { openapiPath: `${questionRoot}/doc` }).pipe(
      Layer.provide(opts.live),
      Layer.provide(HttpServer.layerServices),
    ),
  )

  const init = () =>
    HttpRouter.toWebHandler(
      app as Layer.Layer<
        A,
        E | F,
        | HttpRouter.HttpRouter
        | HttpRouter.Request<"Requires", unknown>
        | HttpRouter.Request<"GlobalRequires", unknown>
        | HttpRouter.Request<"Error", unknown>
        | HttpRouter.Request<"GlobalError", unknown>
      >,
      {
        disableLogger: true,
        memoMap: opts.memoMap,
      },
    ) as {
      readonly handler: (request: Request) => Promise<Response>
      readonly dispose: () => Promise<void>
    }

  let web: ReturnType<typeof init> | undefined

  return (request: Request) => {
    web ??= init()
    return web.handler(request)
  }
}
