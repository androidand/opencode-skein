import { Effect, Layer, Context, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { zod } from "@opencode-ai/core/effect-zod"
import { withStatics } from "@opencode-ai/core/schema"
import * as Session from "./session"
import { SessionID, MessageID, PartID, RewindFilePolicy } from "./schema"
import { SessionTimeline } from "./timeline"

const log = Log.create({ service: "session.revert" })

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
  files: Schema.optional(RewindFilePolicy),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const timeline = yield* SessionTimeline.Service

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      return yield* timeline.rewind(input)
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      log.info("unreverting", input)
      return yield* timeline.restore(input)
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      yield* timeline.commitPending({ sessionID: session.id })
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const defaultLayer = Layer.suspend(() => layer.pipe(Layer.provide(SessionTimeline.defaultLayer)))

export * as SessionRevert from "./revert"
