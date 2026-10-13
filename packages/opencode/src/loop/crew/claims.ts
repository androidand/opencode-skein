import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ClaimTable, ClaimKind, ReleaseReason } from "@opencode-ai/core/loop/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { statics } from "@opencode-ai/schema/schema"
import { Identifier } from "@/id/id"
import { and, eq, isNull } from "drizzle-orm"

export const DefaultStaleAfterMs = 60_000

export const ClaimID = Schema.String.check(Schema.isStartsWith("claim")).pipe(
  Schema.brand("ClaimID"),
  statics((s) => ({
    ascending: () => s.make(Identifier.create("claim", "ascending")),
  })),
)
export type ClaimID = Schema.Schema.Type<typeof ClaimID>

export const ClaimInfo = Schema.Struct({
  id: ClaimID,
  projectID: ProjectV2.ID,
  slug: Schema.String,
  kind: Schema.Literals([...ClaimKind]),
  holderSession: Schema.optional(Schema.String),
  holderHarness: Schema.optional(Schema.String),
  holderName: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  worktree: Schema.optional(Schema.String),
  providerID: Schema.optional(ProviderV2.ID),
  modelID: Schema.optional(ModelV2.ID),
  gate: Schema.optional(Schema.String),
  since: Schema.Finite,
  heartbeat: Schema.Finite,
  releasedAt: Schema.optional(Schema.Finite),
  releaseReason: Schema.optional(Schema.Literals([...ReleaseReason])),
})
.annotate({ identifier: "ClaimInfo" })
export type ClaimInfo = Schema.Schema.Type<typeof ClaimInfo>

export interface ClaimRow {
  id: string
  project_id: string
  slug: string
  kind: string
  holder_session: string | null
  holder_harness: string | null
  holder_name: string | null
  branch: string | null
  worktree: AbsolutePath | null
  provider_id: string | null
  model_id: string | null
  gate: string | null
  since: number
  heartbeat: number
  released_at: number | null
  release_reason: string | null
}

function fromRow(row: ClaimRow): ClaimInfo {
  return {
    id: ClaimID.make(row.id),
    projectID: ProjectV2.ID.make(row.project_id),
    slug: row.slug,
    kind: row.kind as ClaimKind,
    holderSession: row.holder_session ?? undefined,
    holderHarness: row.holder_harness ?? undefined,
    holderName: row.holder_name ?? undefined,
    branch: row.branch ?? undefined,
    worktree: row.worktree ? AbsolutePath.make(row.worktree) : undefined,
    providerID: row.provider_id ? ProviderV2.ID.make(row.provider_id) : undefined,
    modelID: row.model_id ? ModelV2.ID.make(row.model_id) : undefined,
    gate: row.gate ?? undefined,
    since: row.since,
    heartbeat: row.heartbeat,
    releasedAt: row.released_at ?? undefined,
    releaseReason: row.release_reason as ReleaseReason | undefined,
  }
}

export interface Interface {
  readonly claim: (input: CreateClaimInput) => Effect.Effect<ClaimInfo, ClaimExistsError | ClaimNotFoundError>
  readonly heartbeat: (id: ClaimID) => Effect.Effect<ClaimInfo, ClaimNotFoundError | ClaimReleasedError>
  readonly release: (id: ClaimID, reason?: ReleaseReason) => Effect.Effect<ClaimInfo, ClaimNotFoundError>
  readonly listLive: (projectID: ProjectV2.ID) => Effect.Effect<ClaimInfo[]>
  readonly listAbandoned: (projectID: ProjectV2.ID, now?: number) => Effect.Effect<ClaimInfo[]>
}

export class ClaimExistsError extends Schema.TaggedErrorClass<ClaimExistsError>()("ClaimExistsError", {
  slug: Schema.String,
}) {}

export class ClaimNotFoundError extends Schema.TaggedErrorClass<ClaimNotFoundError>()("ClaimNotFoundError", {
  id: ClaimID,
}) {}

/**
 * Distinct from `ClaimNotFoundError`: the row exists, but this claim is no
 * longer live. A heartbeat on a released claim must say so rather than
 * succeed silently — the caller needs to know its claim was lost (taken over
 * as abandoned, or released from under it), not that the world is fine.
 */
export class ClaimReleasedError extends Schema.TaggedErrorClass<ClaimReleasedError>()("ClaimReleasedError", {
  id: ClaimID,
}) {}

export interface CreateClaimInput {
  projectID: ProjectV2.ID
  slug: string
  kind?: ClaimKind
  holderSession?: string
  holderHarness?: string
  holderName?: string
  branch?: string
  worktree?: AbsolutePath
  providerID?: ProviderV2.ID
  modelID?: ModelV2.ID
  gate?: string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CrewClaim") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const get = Effect.fn("Claim.get")(function* (id: ClaimID) {
      const rows = yield* db.select().from(ClaimTable).where(eq(ClaimTable.id, id as string)).all().pipe(Effect.orDie)
      const [found] = rows
      if (!found) return yield* new ClaimNotFoundError({ id })
      return fromRow(found as ClaimRow)
    })

    const claim = Effect.fn("Claim.claim")(function* (input: CreateClaimInput) {
      const now = Date.now()
      const id = ClaimID.ascending()
      const inserted = Effect.gen(function* () {
        yield* db
          .insert(ClaimTable)
          .values([
            {
              id,
              project_id: input.projectID,
              slug: input.slug,
              kind: input.kind ?? "implement",
              holder_session: input.holderSession ?? null,
              holder_harness: input.holderHarness ?? null,
              holder_name: input.holderName ?? null,
              branch: input.branch ?? null,
              worktree: input.worktree ?? null,
              provider_id: input.providerID ?? null,
              model_id: input.modelID ?? null,
              gate: input.gate ?? null,
              since: now,
              heartbeat: now,
            },
          ])
          .run()
      }).pipe(Effect.catch((err: unknown) =>
        isUniqueViolation(err)
          ? Effect.fail(new ClaimExistsError({ slug: input.slug }))
          : Effect.die(err as never),
      ))
      yield* inserted
      return yield* get(ClaimID.make(id))
    })

    // `heartbeat` and `release` are both guarded UPDATEs that must not
    // silently no-op: a heartbeat that WHERE-excludes a released row and
    // still reports success is indistinguishable, to its caller, from a
    // heartbeat that actually landed — the exact bug an exclusivity
    // primitive cannot have. `.returning()` gives the affected row (or none)
    // in the same round trip, with no separate read-then-write race window
    // and no reliance on a driver-specific rows-changed count.

    const heartbeat = Effect.fn("Claim.heartbeat")(function* (id: ClaimID) {
      const now = Date.now()
      const touched = yield* db
        .update(ClaimTable)
        .set({ heartbeat: now })
        .where(and(eq(ClaimTable.id, id as string), isNull(ClaimTable.released_at)))
        .returning({ id: ClaimTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!touched) {
        // Either the id never existed, or it did and is released — get()
        // tells the two apart, propagating ClaimNotFoundError itself when
        // that's the real answer, so the caller hears the right one.
        const current = yield* get(id)
        return yield* new ClaimReleasedError({ id: current.id })
      }
      return yield* get(id)
    })

    const release = Effect.fn("Claim.release")(function* (id: ClaimID, reason?: ReleaseReason) {
      const now = Date.now()
      // Guarded the same way: a second release must not overwrite the first
      // release's timestamp and reason with its own — the claim was already
      // let go, and whatever released it first is the true history.
      yield* db
        .update(ClaimTable)
        .set({ released_at: now, release_reason: reason ?? null })
        .where(and(eq(ClaimTable.id, id as string), isNull(ClaimTable.released_at)))
        .returning({ id: ClaimTable.id })
        .get()
        .pipe(Effect.orDie)
      // Releasing twice is a normal race to say "I'm done" — idempotent by
      // design, unlike heartbeat, where the caller specifically needs to
      // know it lost the claim. Either way the WHERE guard already made sure
      // only the FIRST release's timestamp and reason stick; what changed or
      // didn't, get() reports the same either way.
      return yield* get(id)
    })

    const listLive = Effect.fn("Claim.listLive")(function* (projectID: ProjectV2.ID) {
      const rows = yield* db
        .select()
        .from(ClaimTable)
        .where(and(eq(ClaimTable.project_id, projectID), isNull(ClaimTable.released_at)))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const listAbandoned = Effect.fn("Claim.listAbandoned")(function* (projectID: ProjectV2.ID, now = Date.now()) {
      const rows = yield* db
        .select()
        .from(ClaimTable)
        .where(and(eq(ClaimTable.project_id, projectID), isNull(ClaimTable.released_at)))
        .all()
        .pipe(Effect.orDie)
      return rows.filter((row) => now - row.heartbeat >= DefaultStaleAfterMs).map(fromRow)
    })

    return Service.of({ claim, heartbeat, release, listLive, listAbandoned })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

function isUniqueViolation(err: unknown): boolean {
  if (err == null) return false
  const text =
    err instanceof Error
      ? `${err.message} ${err.cause ? String(err.cause) : ""}`
      : String(err)
  return text.includes("UNIQUE constraint failed")
}

export { ClaimTable, ClaimKind, ReleaseReason }

export * as Claim from "./claims"