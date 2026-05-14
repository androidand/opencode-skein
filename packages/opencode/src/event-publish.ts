import { SyncEvent } from "@/sync"
import { Event } from "@opencode-ai/core/event"
import { Effect } from "effect"

export function publish<D extends Event.Definition>(
  events: Event.Interface,
  sync: SyncEvent.Interface,
  definition: D,
  data: Event.Data<D>,
) {
  return Effect.gen(function* () {
    const persisted = yield* sync.run(definition, data as SyncEvent.Event<D>["data"], { publish: false })
    return yield* events.publish(definition, data, {
      id: Event.ID.make(persisted.id),
      metadata: {
        sync: {
          seq: persisted.seq,
          aggregateID: persisted.aggregateID,
        },
      },
    })
  })
}

export * as EventPublish from "./event-publish"
