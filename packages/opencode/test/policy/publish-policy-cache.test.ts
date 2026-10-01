import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, mkdir, utimes, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { PublishPolicy } from "@/policy/publish-policy"

// These cases exist because the mtime-only cache was wrong: the loader's verdict
// depends on the forge's visibility and the remote's URL, neither of which
// touches the policy file. A repository flipped from private to public therefore
// kept its grant indefinitely — the "still parses but stopped meaning anything"
// failure this whole plan exists to prevent.
//
// They drive `cachedLoad` itself with injected dependencies and an explicit
// clock, so the TTL boundary is exercised exactly rather than approximated by
// sleeping, and the test exercises the same code production runs.

// A hand-advanced clock. The cache takes `now` as a parameter precisely so this is
// a plain assignment rather than a test-clock layer, so the TTL boundary is
// exercised exactly rather than approximately.
const clock = { now: 1_700_000_000_000 }
const advance = (ms: number) => (clock.now += ms)
const run = <A, E>(program: Effect.Effect<A, E, never>) => Effect.runPromise(program)

const VALID = `version: 1
repo: androidand/opencode-skein
visibility: public
commit:
  branches: ["loop/*"]
push:
  remotes: [origin]
  branches: ["loop/*"]
merge:
  into: [dev]
  method: squash
  requires: [gates, review]
  by: [integrator]
`

async function repo() {
  const dir = await mkdtemp(path.join(tmpdir(), "publish-cache-"))
  await mkdir(path.join(dir, ".skein"), { recursive: true })
  await writeFile(path.join(dir, ".skein", "publish-policy.yaml"), VALID)
  PublishPolicy.invalidate(dir)
  const state = { visibility: "public" }
  const deps: PublishPolicy.LoadDeps = {
    visibility: () => Effect.succeed(state.visibility),
    remoteUrl: () => Effect.succeed("git@github.com:androidand/opencode-skein.git"),
    defaultBranch: Effect.succeed("dev"),
    readFile: (file) => Effect.promise(() => Bun.file(file).exists().then((e) => (e ? Bun.file(file).text() : undefined))),
  }
  return { dir, state, deps }
}

/**
 * Rewrites the policy and pins a definitively newer mtime.
 *
 * TestClock moves virtual time only, so a real filesystem timestamp would not
 * advance and the mtime half of the key could not be tested through it. Setting
 * the mtime explicitly makes the assertion about the cache rather than about
 * filesystem timestamp granularity.
 */
describe("policy cache age", () => {
  test("serves the cached grant while it is fresh", async () => {
    const { dir, deps } = await repo()
    const result = await run(
      Effect.gen(function* () {
        const first = yield* PublishPolicy.cachedLoad({ directory: dir, deps, now: clock.now })
        const second = yield* PublishPolicy.cachedLoad({ directory: dir, deps, now: clock.now })
        return [first?.visibility ?? null, second?.visibility ?? null]
      }),
    )
    expect(result).toEqual(["public", "public"])
  })

  test("re-reads after the TTL and denies when visibility has flipped", async () => {
    // The bug: the policy file is untouched, so an mtime-keyed cache keeps the
    // grant forever. Only the age check re-runs the load, which now refuses.
    const { dir, state, deps } = await repo()
    const result = await run(
      Effect.gen(function* () {
        const granted = yield* PublishPolicy.cachedLoad({ directory: dir, deps, now: clock.now })
        state.visibility = "private"
        yield* Effect.sync(() => advance(61_000))
        const after = yield* PublishPolicy.cachedLoad({ directory: dir, deps, now: clock.now })
        return { granted: granted?.visibility ?? null, after: after?.visibility ?? null }
      }),
    )
    expect(result).toEqual({ granted: "public", after: null })
  })

test("an unreachable forge denies rather than serving the stale grant", async () => {
    const { dir, deps } = await repo()
    const flaky: PublishPolicy.LoadDeps = { ...deps, visibility: () => Effect.fail(new Error("forge unreachable")) }
    const result = await run(
      Effect.gen(function* () {
        const granted = yield* PublishPolicy.cachedLoad({ directory: dir, deps, now: clock.now })
        yield* Effect.sync(() => advance(61_000))
        const after = yield* PublishPolicy.cachedLoad({ directory: dir, deps: flaky, now: clock.now })
        // A third call, still inside the forge outage. This is the case that
        // matters: whatever the failed reload left in the cache, nothing here may
        // hand back the grant that was cached before the outage.
        const third = yield* PublishPolicy.cachedLoad({ directory: dir, deps: flaky, now: clock.now })
        return {
          granted: granted?.visibility ?? null,
          after: after?.visibility ?? null,
          third: third?.visibility ?? null,
        }
      }),
    )
    expect(result).toEqual({ granted: "public", after: null, third: null })
  })

  test("a remoted remote is picked up after the TTL", async () => {
    // Same class as the visibility flip, different external fact: the policy file
    // never mentions the URL, so only re-loading can notice.
    const { dir, deps } = await repo()
    const repointed: PublishPolicy.LoadDeps = {
      ...deps,
      remoteUrl: () => Effect.succeed("git@github.com:someone-else/other.git"),
    }
    const result = await run(
      Effect.gen(function* () {
        const granted = yield* PublishPolicy.cachedLoad({ directory: dir, deps, now: clock.now })
        yield* Effect.sync(() => advance(61_000))
        const after = yield* PublishPolicy.cachedLoad({ directory: dir, deps: repointed, now: clock.now })
        return { granted: granted?.repo ?? null, after: after?.repo ?? null }
      }),
    )
    expect(result).toEqual({ granted: "androidand/opencode-skein", after: null })
  })

  test("an edited policy takes effect at once, without waiting out the TTL", async () => {
    // The mtime half of the key still does its job: no TTL is waited out, and the
    // new branches apply immediately.
    const { dir, deps } = await repo()
    const first = await run(PublishPolicy.cachedLoad({ directory: dir, deps, now: clock.now }))
    expect(first?.commit.branches).toEqual(["loop/*"])

    const file = path.join(dir, ".skein", "publish-policy.yaml")
    const future = Date.now() + 60_000
    await writeFile(file, VALID.replace('branches: ["loop/*"]', 'branches: ["other/*"]'))
    await utimes(file, future / 1000, future / 1000)

    const second = await run(PublishPolicy.cachedLoad({ directory: dir, deps, now: clock.now }))
    expect(second?.commit.branches).toEqual(["other/*"])
  })

  test("the same directory is not shared between tests", async () => {
    // Each case gets a fresh temp dir and an explicit invalidate, so one test's
    // cached grant cannot decide another's outcome.
    const a = await repo()
    const b = await repo()
    expect(a.dir).not.toBe(b.dir)
    const result = await run(
      Effect.gen(function* () {
        yield* PublishPolicy.cachedLoad({ directory: a.dir, deps: a.deps, now: clock.now })
        return (yield* PublishPolicy.cachedLoad({ directory: b.dir, deps: b.deps, now: clock.now }))?.repo ?? null
      }),
    )
    expect(result).toBe("androidand/opencode-skein")
  })
})