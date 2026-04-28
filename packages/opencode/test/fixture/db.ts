import { rm } from "fs/promises"
import { Database } from "@/storage/db"
import { disposeAllInstances } from "./fixture"

// Order matters and must stay serial: every runtime that transitively consumes
// `DatabaseEffect.layer` shares the global layer memoMap with the others, so
// each one's memoized Service value still references the live SQLite handle.
// We dispose every runtime/handler first, then close the DB. If a future
// module-scoped runtime is added that depends on the DB, register its
// dispose() here.
export async function resetDatabase() {
  await disposeAllInstances().catch(() => undefined)
  Database.close()
  await rm(Database.Path, { force: true }).catch(() => undefined)
  await rm(`${Database.Path}-wal`, { force: true }).catch(() => undefined)
  await rm(`${Database.Path}-shm`, { force: true }).catch(() => undefined)
}
