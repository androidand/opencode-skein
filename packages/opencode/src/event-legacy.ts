import { Bus as ProjectBus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { SyncEvent } from "@/sync"
import { Event } from "@opencode-ai/core/event"
import "@opencode-ai/core/catalog"
import { Effect } from "effect"

const normal = new Map<string, BusEvent.Definition>()

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

Event.installBridge({
  define(definition) {
    if (definition.version !== undefined) {
      SyncEvent.defineExternal({ type: definition.type, version: definition.version, schema: definition.schema })
      return
    }
    if (normal.has(definition.type)) return
    normal.set(definition.type, BusEvent.define(definition.type, definition.schema))
  },

  publish(definition, event) {
    if (definition.version !== undefined) {
      const version = definition.version
      return Effect.sync(() => {
        GlobalBus.emit("event", {
          directory: event.instance?.directory,
          workspace: event.instance?.workspaceID,
          payload: {
            type: "sync",
            name: SyncEvent.versionedType(definition.type, version),
            id: event.id,
            seq: 0,
            aggregateID: event.id,
            data: event.data,
          },
        })
      })
    }

    const legacy = normal.get(definition.type)
    if (!legacy) return Effect.sync(() => emitNormal(event))
    return Effect.tryPromise(() => ProjectBus.publish(legacy, event.data, { id: event.id })).pipe(
      Effect.catch(() => Effect.sync(() => emitNormal(event))),
    )
  },
})
