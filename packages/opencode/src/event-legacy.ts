import { Bus as ProjectBus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { SyncEvent } from "@/sync"
import { Event } from "@opencode-ai/core/event"
import "@opencode-ai/core/catalog"
import "@opencode-ai/core/session-event"
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
    const sync = yield* SyncEvent.Service

    yield* events.subscribeAll().pipe(Stream.runForEach(republish(bus, sync)), Effect.forkScoped)
  }),
)

export const defaultLayer: Layer.Layer<never> = layer.pipe(
  Layer.provideMerge(Event.defaultLayer),
  Layer.provideMerge(SyncEvent.defaultLayer),
  Layer.provide(ProjectBus.defaultLayer),
) as unknown as Layer.Layer<never>

const republish = (bus: ProjectBus.Interface, sync: SyncEvent.Interface) => (event: Event.Payload) => {
  const definition = Event.registry.get(event.type)
  if (!definition) return Effect.void

  const publishNormal = bus.publish({ type: definition.type, properties: definition.schema }, event.data, { id: event.id }).pipe(
    Effect.catch(() => Effect.sync(() => emitNormal(event))),
  )
  if (definition.version === undefined) return publishNormal

  return Effect.gen(function* () {
    const existing = syncMetadata(event)
    const persisted = existing
      ? undefined
      : yield* sync.run(definition, event.data, { id: event.id, publish: false }).pipe(Effect.option)
    yield* publishNormal
    yield* Effect.sync(() => {
      const syncEvent = existing ?? (persisted?._tag === "Some" ? persisted.value : undefined)
      GlobalBus.emit("event", {
        directory: event.instance?.directory,
        workspace: event.instance?.workspaceID,
        payload: {
          type: "sync",
          name: SyncEvent.versionedType(definition.type, definition.version!),
          id: event.id,
          seq: syncEvent?.seq ?? 0,
          aggregateID: syncEvent?.aggregateID ?? aggregateID(definition, event),
          data: event.data,
        },
      })
    })
  })
}

function syncMetadata(event: Event.Payload) {
  const metadata = event.metadata?.sync
  if (typeof metadata !== "object" || metadata === null) return
  if (!("seq" in metadata) || !("aggregateID" in metadata)) return
  if (typeof metadata.seq !== "number" || typeof metadata.aggregateID !== "string") return
  return metadata
}

function aggregateID(definition: Event.Definition, event: Event.Payload) {
  if (!definition.aggregate) return event.id
  const value = (event.data as Record<string, unknown>)[definition.aggregate]
  return typeof value === "string" ? value : event.id
}

export * as EventLegacy from "./event-legacy"
