import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { ProjectTable } from "../project/sql"
import { AbsolutePath } from "../schema"

export const ClaimKind = ["implement", "review", "integrate", "triage", "decide"] as const
export type ClaimKind = (typeof ClaimKind)[number]

export const ReleaseReason = ["completed", "quarantined", "abandoned", "cancelled", "human"] as const
export type ReleaseReason = (typeof ReleaseReason)[number]

export const ClaimTable = sqliteTable("claims", {
  id: text().primaryKey(),
  project_id: text()
    .$type<typeof ProjectTable.$inferSelect.id>()
    .notNull()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  slug: text().notNull(),
  kind: text().$type<ClaimKind>().notNull().default("implement"),
  holder_session: text(),
  holder_harness: text(),
  holder_name: text(),
  branch: text(),
  worktree: text().$type<AbsolutePath>(),
  provider_id: text(),
  model_id: text(),
  gate: text(),
  since: integer().notNull(),
  heartbeat: integer().notNull(),
  released_at: integer(),
  release_reason: text().$type<ReleaseReason>(),
  ...Timestamps,
})
