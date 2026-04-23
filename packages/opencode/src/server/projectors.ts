import { Schema } from "effect"
import sessionProjectors from "../session/projectors"
import { SyncEvent } from "@/sync"
import { Session } from "@/session"
import { SessionTable } from "@/session/session.sql"
import { Database, eq } from "@/storage"

const isSessionUpdated = Schema.is(Session.Event.Updated.schema)

export function initProjectors() {
  SyncEvent.init({
    projectors: sessionProjectors,
    convertEvent: (type, data) => {
      if (type === Session.Event.Updated.type && isSessionUpdated(data)) {
        const id = data.sessionID
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())

        if (!row) return data

        return {
          sessionID: id,
          info: Session.fromRow(row),
        }
      }
      return data
    },
  })
}

initProjectors()
