import { Effect, Layer, Context, Schema } from "effect"
import { Bus } from "@/bus"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { zod } from "@opencode-ai/core/effect-zod"
import { withStatics } from "@opencode-ai/core/schema"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID, RewindFilePolicy } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"

export const RewindInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
  files: Schema.optional(RewindFilePolicy),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type RewindInput = Schema.Schema.Type<typeof RewindInput>

export interface Interface {
  readonly rewind: (input: RewindInput) => Effect.Effect<Session.Info>
  readonly restore: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info>
  readonly commitPending: (input: { sessionID: SessionID }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTimeline") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service

    const rewind = Effect.fn("SessionTimeline.rewind")(function* (input: RewindInput) {
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID })
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const files = input.files ?? "revert"
      let lastUser: MessageV2.User | undefined
      let rev: Session.Info["revert"]
      const patches: Snapshot.Patch[] = []
      const range: MessageV2.WithParts[] = []

      for (const msg of all) {
        if (msg.info.role === "user") lastUser = msg.info
        const remaining = []
        for (const part of msg.parts) {
          if (rev) {
            if (files === "revert" && part.type === "patch") patches.push(part)
            continue
          }

          if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
            const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
            rev = {
              messageID: !partID && lastUser ? lastUser.id : msg.info.id,
              partID,
              ...(files === "keep" && { files }),
            }
          }
          remaining.push(part)
        }
        if (rev) range.push(msg)
      }

      if (!rev) return session

      if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)
      if (files === "revert") {
        rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
        yield* snap.revert(patches)
        if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
      }
      const diffs = yield* summary.computeDiff({ messages: range })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
      yield* sessions.setRevert({
        sessionID: input.sessionID,
        revert: rev,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const restore = Effect.fn("SessionTimeline.restore")(function* (input: { sessionID: SessionID }) {
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      if (session.revert.files !== "keep" && session.revert.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* sessions.clearRevert(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const commitPending = Effect.fn("SessionTimeline.commitPending")(function* (input: { sessionID: SessionID }) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID })
      const messageID = session.revert.messageID
      const remove = [] as MessageV2.WithParts[]
      let target: MessageV2.WithParts | undefined
      for (const msg of msgs) {
        if (msg.info.id < messageID) continue
        if (msg.info.id > messageID) {
          remove.push(msg)
          continue
        }
        if (session.revert.partID) {
          target = msg
          continue
        }
        remove.push(msg)
      }
      for (const msg of remove) {
        yield* sessions.removeMessage({
          sessionID,
          messageID: msg.info.id,
        })
      }
      if (session.revert.partID && target) {
        const idx = target.parts.findIndex((part) => part.id === session.revert?.partID)
        if (idx >= 0) {
          for (const part of target.parts.slice(idx)) {
            yield* sessions.removePart({
              sessionID,
              messageID: target.info.id,
              partID: part.id,
            })
          }
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ rewind, restore, commitPending })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(SessionSummary.defaultLayer),
  ),
)

export * as SessionTimeline from "./timeline"
