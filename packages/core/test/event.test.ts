import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { Event } from "@opencode-ai/core/event"
import { Instance } from "@opencode-ai/core/instance"
import { testEffect } from "./lib/effect"

const instanceLayer = Layer.succeed(
  Instance.Service,
  Instance.Service.of({ directory: "project", workspaceID: "workspace" }),
)
const it = testEffect(Event.layer.pipe(Layer.provideMerge(instanceLayer)))
const itWithoutInstance = testEffect(Event.layer)

const Message = Event.define({
  type: "test.message",
  schema: {
    text: Schema.String,
  },
})

const GlobalMessage = Event.define({
  type: "test.global",
  schema: {
    text: Schema.String,
  },
})

const VersionedMessage = Event.define({
  type: "test.versioned",
  version: 2,
  schema: {
    text: Schema.String,
  },
})

describe("Event", () => {
  it.effect("publishes events with the current instance", () =>
    Effect.gen(function* () {
      const events = yield* Event.Service
      const fiber = yield* events.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* events.publish(Message, { text: "hello" })
      const received = Array.from(yield* Fiber.join(fiber))

      expect(received).toEqual([event])
      expect(event.type).toBe("test.message")
      expect(event).not.toHaveProperty("version")
      expect(event.data).toEqual({ text: "hello" })
      expect(event.instance).toEqual({ directory: "project", workspaceID: "workspace" })
    }),
  )

  itWithoutInstance.effect("omits instance when no instance is available", () =>
    Effect.gen(function* () {
      const events = yield* Event.Service
      const event = yield* events.publish(GlobalMessage, { text: "hello" })

      expect(event).not.toHaveProperty("instance")
      expect(event.type).toBe("test.global")
    }),
  )

  it.effect("publishes definition version", () =>
    Effect.gen(function* () {
      const events = yield* Event.Service
      const event = yield* events.publish(VersionedMessage, { text: "hello" })

      expect(event.type).toBe("test.versioned")
      expect(event.version).toBe(2)
    }),
  )

  it.effect("stores definitions in the exported registry", () =>
    Effect.sync(() => {
      expect(Event.registry.get(Message.type)).toBe(Message)
    }),
  )

  it.effect("publishes to typed and wildcard subscriptions", () =>
    Effect.gen(function* () {
      const events = yield* Event.Service
      const typed = yield* events.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const wildcard = yield* events.subscribeAll().pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* events.publish(Message, { text: "hello" })

      expect(Array.from(yield* Fiber.join(typed))).toEqual([event])
      expect(Array.from(yield* Fiber.join(wildcard))).toEqual([event])
    }),
  )
})
