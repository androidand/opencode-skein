import { Bus as ProjectBus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { SyncEvent } from "@/sync"
import { Event } from "@opencode-ai/core/event"
import "@opencode-ai/core/catalog"
import { Effect, Layer, Stream } from "effect"

function emitNormal(event: Event.Payload) {
  GlobalBus.emit("event", {
    directory: event.instance?.directory,
    workspace: event.instance?.workspaceID,
    payload: {
      id: event.id,
      type: event.type,
      properties: event.data,
    },
  })
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* Event.Service
    const bus = yield* ProjectBus.Service

    yield* events.subscribeAll().pipe(Stream.runForEach(republish(bus)), Effect.forkScoped)
  }),
)

export const defaultLayer = layer.pipe(Layer.provideMerge(Event.defaultLayer), Layer.provide(ProjectBus.defaultLayer))

const republish = (bus: ProjectBus.Interface) => (event: Event.Payload) => {
  const definition = Event.registry.get(event.type)
  if (!definition) return Effect.void
  if (definition.version !== undefined) {
    return Effect.sync(() => {
      GlobalBus.emit("event", {
        directory: event.instance?.directory,
        workspace: event.instance?.workspaceID,
        payload: {
          type: "sync",
          name: SyncEvent.versionedType(definition.type, definition.version!),
          id: event.id,
          seq: 0,
          aggregateID: event.id,
          data: event.data,
        },
      })
    })
  }

  return bus.publish({ type: definition.type, properties: definition.schema }, event.data, { id: event.id }).pipe(
    Effect.catch(() => Effect.sync(() => emitNormal(event))),
  )
}

export * as EventLegacy from "./event-legacy"
