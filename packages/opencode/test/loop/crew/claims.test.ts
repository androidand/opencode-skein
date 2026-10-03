import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ClaimTable } from "@opencode-ai/core/loop/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project, ProjectV2 } from "@opencode-ai/core/project"
import { testEffect } from "../../lib/effect"
import { Claim } from "@/loop/crew/claims"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Claim.node, Database.node, Project.node])),
)

const projectID = ProjectV2.ID.make("test-project")

function seedProject() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values([
        {
          id: projectID,
          worktree: AbsolutePath.make("/tmp/test-project"),
          vcs: "git",
          name: "Test",
          sandboxes: [],
        },
      ])
      .run()
      .pipe(Effect.orDie)
  })
}

describe("Claim", () => {
  it.effect("atomic claim rejects a second holder", () =>
    Effect.gen(function* () {
      yield* seedProject()
      const service = yield* Claim.Service

      yield* service.claim({
        projectID,
        slug: "crew-loop-1",
        holderSession: "ses-first",
        holderName: "agent-1",
        worktree: AbsolutePath.make("/tmp/crew-loop-1"),
      })

      const conflict = yield* service
        .claim({ projectID, slug: "crew-loop-1", holderSession: "ses-second" })
        .pipe(Effect.catch(() => Effect.succeed(true)))
      expect(conflict).toBe(true)
    }),
  )

  it.effect("heartbeat refreshes staleness", () =>
    Effect.gen(function* () {
      yield* seedProject()
      const service = yield* Claim.Service

      const created = yield* service.claim({ projectID, slug: "crew-loop-2", holderSession: "ses-1" })
      const refreshed = yield* service.heartbeat(created.id)
      expect(refreshed.heartbeat).toBeGreaterThanOrEqual(created.heartbeat)
    }),
  )

  it.effect("release marks a claim released and removes it from live", () =>
    Effect.gen(function* () {
      yield* seedProject()
      const service = yield* Claim.Service

      const created = yield* service.claim({ projectID, slug: "crew-loop-3", holderSession: "ses-1" })
      const released = yield* service.release(created.id, "completed")
      expect(released.releasedAt).toBeDefined()
      const live = yield* service.listLive(projectID)
      expect(live).toHaveLength(0)
    }),
  )

  it.effect("release is idempotent: a second release does not overwrite the first", () =>
    Effect.gen(function* () {
      yield* seedProject()
      const service = yield* Claim.Service

      const created = yield* service.claim({ projectID, slug: "crew-loop-3b", holderSession: "ses-1" })
      const first = yield* service.release(created.id, "completed")
      // A colleague, or the same holder retrying, releasing again must not
      // stamp a new time or a different reason over the original release.
      const second = yield* service.release(created.id, "abandoned")
      expect(second.releasedAt).toBe(first.releasedAt)
      expect(second.releaseReason).toBe("completed")
    }),
  )

  it.effect("heartbeat on an already-released claim reports the loss, not success", () =>
    Effect.gen(function* () {
      yield* seedProject()
      const service = yield* Claim.Service

      const created = yield* service.claim({ projectID, slug: "crew-loop-3c", holderSession: "ses-1" })
      yield* service.release(created.id, "abandoned")

      const tag = yield* service.heartbeat(created.id).pipe(Effect.catch((err) => Effect.succeed(err._tag)))
      expect(tag).toBe("ClaimReleasedError")
    }),
  )

  it.effect("listLive shows only live claims", () =>
    Effect.gen(function* () {
      yield* seedProject()
      const service = yield* Claim.Service

      yield* service.claim({ projectID, slug: "crew-loop-4", holderSession: "ses-1" })
      yield* service.claim({ projectID, slug: "crew-loop-5", holderSession: "ses-2" })
      const live = yield* service.listLive(projectID)
      expect(live).toHaveLength(2)
    }),
  )

  it.effect("listAbandoned detects stale claims", () =>
    Effect.gen(function* () {
      yield* seedProject()
      const service = yield* Claim.Service

      yield* service.claim({ projectID, slug: "crew-loop-6", holderSession: "ses-1" })
      yield* service.claim({ projectID, slug: "crew-loop-7", holderSession: "ses-2" })

      const { db } = yield* Database.Service
      const staleSince = Date.now() - 20 * Claim.DefaultStaleAfterMs
      yield* db
        .update(ClaimTable)
        .set({ heartbeat: staleSince })
        .where(eq(ClaimTable.slug, "crew-loop-6"))
        .run()
        .pipe(Effect.orDie)

      const abandoned = yield* service.listAbandoned(projectID)
      const abandonedSlugs = abandoned.map((c) => c.slug)
      expect(abandonedSlugs).toContain("crew-loop-6")
      expect(abandonedSlugs).not.toContain("crew-loop-7")
    }),
  )
})
