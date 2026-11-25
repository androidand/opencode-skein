import { sql } from "drizzle-orm"
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import { ProjectTable } from "../project/sql"
import { ProviderV2 } from "../provider"
import { ModelV2 } from "../model"
import { ProjectV2 } from "../project"
import { Timestamps } from "../database/schema.sql"

export const ClaimKind = ["implement", "review", "integrate", "triage", "decide"] as const
export type ClaimKind = (typeof ClaimKind)[number]

export const ReleaseReason = ["completed", "quarantined", "abandoned", "cancelled", "human"] as const
export type ReleaseReason = (typeof ReleaseReason)[number]

export const ClaimTable = sqliteTable(
  "claims",
  {
    id: text().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    slug: text().notNull(),
    kind: text().$type<ClaimKind>().notNull().default("implement"),
    holder_session: text(),
    holder_harness: text(),
    holder_name: text(),
    branch: text(),
    worktree: DatabasePath.absoluteColumn(),
    provider_id: text().$type<ProviderV2.ID>(),
    model_id: text().$type<ModelV2.ID>(),
    gate: text(),
    since: integer().notNull(),
    heartbeat: integer().notNull(),
    released_at: integer(),
    release_reason: text().$type<ReleaseReason>(),
    ...Timestamps,
  },
  (table) => [
    // One live holder per (project, slug). The partial index leaves released
    // rows free to reuse the slug, so an archived change can be re-claimed.
    uniqueIndex("claims_project_slug_live_idx")
      .on(table.project_id, table.slug)
      .where(sql`${table.released_at} IS NULL`),
    index("claims_holder_idx").on(table.holder_session),
    index("claims_project_idx").on(table.project_id),
    index("claims_slug_idx").on(table.slug),
  ],
)
