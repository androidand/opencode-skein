import path from "path"
import z from "zod"
import { Context, Deferred, Effect, Layer, Option } from "effect"
import * as Stream from "effect/Stream"
import { Fff } from "#fff"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { AppFileSystem } from "@/filesystem"
import { Global } from "@/global"
import { Glob } from "@/util/glob"
import { Log } from "@/util/log"
import { Ripgrep } from "./ripgrep"

export namespace Search {
  const log = Log.create({ service: "file.search" })
  const root = path.join(Global.Path.cache, "fff")

  export const Match = z.object({
    path: z.object({
      text: z.string(),
    }),
    lines: z.object({
      text: z.string(),
    }),
    line_number: z.number(),
    absolute_offset: z.number(),
    submatches: z.array(
      z.object({
        match: z.object({
          text: z.string(),
        }),
        start: z.number(),
        end: z.number(),
      }),
    ),
  })

  export type Item = z.infer<typeof Match>

  export interface Result {
    readonly items: Item[]
    readonly partial: boolean
    readonly engine: "fff" | "ripgrep"
    readonly regexFallbackError?: string
  }

  export interface FileInput {
    readonly cwd: string
    readonly query: string
    readonly limit?: number
    readonly current?: string
  }

  export interface GlobInput {
    readonly cwd: string
    readonly pattern: string
    readonly limit?: number
    readonly signal?: AbortSignal
  }

  interface Query {
    readonly dir: string
    readonly text: string
    readonly files: string[]
  }

  interface State {
    readonly pick: Map<string, Fff.Picker>
    readonly wait: Map<string, Deferred.Deferred<Fff.Picker, Error>>
    readonly recent: Query[]
  }

  export interface Interface {
    readonly files: (input: Ripgrep.FilesInput) => Stream.Stream<string, Error>
    readonly tree: (input: Ripgrep.TreeInput) => Effect.Effect<string, Error>
    readonly search: (input: Ripgrep.SearchInput) => Effect.Effect<Result, Error>
    readonly file: (input: FileInput) => Effect.Effect<string[]>
    readonly glob: (input: GlobInput) => Effect.Effect<{ files: string[]; truncated: boolean }, Error>
    readonly open: (input: { cwd?: string; file: string }) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Search") {}

  function key(dir: string) {
    return Buffer.from(dir).toString("base64url")
  }

  function norm(text: string) {
    return text.replaceAll("\\", "/")
  }

  function blocked(rel: string) {
    return norm(rel).split("/").includes(".git")
  }

  function base(file: string) {
    return norm(file).split("/").at(-1) ?? file
  }

  function allow(glob: string[] | undefined, rel: string, file: string) {
    if (!glob?.length) return true
    const yes = glob.filter((item) => !item.startsWith("!"))
    const no = glob.filter((item) => item.startsWith("!")).map((item) => item.slice(1))
    if (yes.length > 0 && !yes.some((item) => Glob.match(item, rel) || Glob.match(item, file))) return false
    if (no.some((item) => Glob.match(item, rel) || Glob.match(item, file))) return false
    return true
  }

  function include(pattern: string) {
    const val = pattern.trim().replaceAll("\\", "/")
    if (!val) return "*"
    const flat = val.replaceAll("**/", "").replaceAll("/**", "/")
    const idx = flat.lastIndexOf("/")
    if (idx < 0) return flat
    const dir = flat.slice(0, idx + 1)
    const glob = flat.slice(idx + 1)
    if (!glob) return dir
    return `${dir} ${glob}`
  }

  function remember(st: State, dir: string, text: string, files: string[]) {
    if (!files.length) return
    const next = Array.from(new Set(files.map(AppFileSystem.resolve))).slice(0, 64)
    if (!next.length) return
    const old = st.recent.findIndex((item) => item.dir === dir && item.text === text)
    if (old >= 0) st.recent.splice(old, 1)
    st.recent.unshift({ dir, text, files: next })
    if (st.recent.length > 32) st.recent.length = 32
  }

  function item(hit: Fff.Hit): Item {
    return {
      path: { text: norm(hit.relativePath) },
      lines: { text: hit.lineContent },
      line_number: hit.lineNumber,
      absolute_offset: hit.byteOffset,
      submatches: hit.matchRanges
        .map(([start, end]) => {
          const text = hit.lineContent.slice(start, end)
          if (!text) return undefined
          return {
            match: { text },
            start,
            end,
          }
        })
        .filter((row): row is Item["submatches"][number] => Boolean(row)),
    }
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const rg = yield* Ripgrep.Service
      const state = yield* InstanceState.make<State>(
        Effect.fn("Search.state")(() =>
          Effect.gen(function* () {
            const next: State = {
              pick: new Map(),
              wait: new Map(),
              recent: [],
            }
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const pick of next.pick.values()) pick.destroy()
              }),
            )
            return next
          }),
        ),
      )

      const rip = Effect.fn("Search.rip")(function* (input: Ripgrep.SearchInput) {
        const out = yield* rg.search(input)
        return {
          items: out.items,
          partial: out.partial,
          engine: "ripgrep" as const,
        }
      })

      const picker = Effect.fn("Search.picker")(function* (cwd: string) {
        if (!Fff.available()) return undefined
        const dir = AppFileSystem.resolve(cwd)
        const st = yield* InstanceState.get(state)
        const old = st.pick.get(dir)
        if (old) return old

        const wait = st.wait.get(dir)
        if (wait) return yield* Deferred.await(wait)

        const gate = yield* Deferred.make<Fff.Picker, Error>()
        st.wait.set(dir, gate)
        try {
          yield* fs.ensureDir(root)
          const id = key(dir)
          const made = yield* Effect.sync(() =>
            Fff.create({
              basePath: dir,
              frecencyDbPath: path.join(root, `${id}.frecency.mdb`),
              historyDbPath: path.join(root, `${id}.history.mdb`),
              aiMode: true,
            }),
          )
          if (!made.ok) {
            const err = new Error(made.error)
            yield* Deferred.fail(gate, err)
            return yield* Effect.fail(err)
          }

          const pick = made.value
          const done = yield* Effect.sync(() => pick.waitForScan(5_000))
          if (!done.ok) {
            pick.destroy()
            const err = new Error(done.error)
            yield* Deferred.fail(gate, err)
            return yield* Effect.fail(err)
          }
          if (!done.value) {
            pick.destroy()
            const err = new Error("fff scan timed out")
            yield* Deferred.fail(gate, err)
            return yield* Effect.fail(err)
          }

          const git = yield* Effect.sync(() => pick.refreshGitStatus())
          if (!git.ok) {
            log.warn("git refresh failed", { dir, error: git.error })
          }

          st.pick.set(dir, pick)
          yield* Deferred.succeed(gate, pick)
          return pick
        } finally {
          if (st.wait.get(dir) === gate) st.wait.delete(dir)
        }
      })

      const files: Interface["files"] = (input) => rg.files(input)
      const tree: Interface["tree"] = (input) => rg.tree(input)

      const file: Interface["file"] = Effect.fn("Search.file")(function* (input) {
        const query = input.query.trim()
        if (!query) return []
        const pick = yield* picker(input.cwd).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!pick) return []

        const dir = AppFileSystem.resolve(input.cwd)
        const out = yield* Effect.sync(() =>
          pick.fileSearch(query, {
            currentFile: input.current
              ? path.isAbsolute(input.current)
                ? input.current
                : path.join(dir, input.current)
              : undefined,
            pageIndex: 0,
            pageSize: Math.max(input.limit ?? 100, 100),
          }),
        )
        if (!out.ok) {
          log.warn("fff file search failed", { dir, query, error: out.error })
          return []
        }

        const min = query.length * 10
        const rows = Array.from(
          new Set(
            out.value.items.flatMap((item, idx) => {
              const score = out.value.scores[idx]
              if (!score || score.total < min) return []
              return [norm(item.relativePath)]
            }),
          ),
        )
        remember(
          yield* InstanceState.get(state),
          dir,
          query,
          rows.map((row) => path.join(dir, row)),
        )
        return rows.slice(0, input.limit ?? 100)
      })

      const search: Interface["search"] = Effect.fn("Search.search")(function* (input) {
        input.signal?.throwIfAborted()
        if (input.file?.length) return yield* rip(input)

        const pick = yield* picker(input.cwd).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!pick) return yield* rip(input)

        const dir = AppFileSystem.resolve(input.cwd)
        const limit = input.limit ?? 100
        const rows: Item[] = []
        const seen = new Set<string>()
        let cur: Fff.Cursor = null
        let err: string | undefined

        while (rows.length < limit) {
          input.signal?.throwIfAborted()
          const out = yield* Effect.sync(() =>
            pick.grep(input.pattern, {
              mode: "regex",
              cursor: cur,
              maxMatchesPerFile: limit,
              timeBudgetMs: 1_500,
            }),
          )
          if (!out.ok) {
            log.warn("fff grep failed", { dir, pattern: input.pattern, error: out.error })
            return yield* rip(input)
          }

          err = err ?? out.value.regexFallbackError
          for (const hit of out.value.items) {
            const rel = norm(hit.relativePath)
            if (!allow(input.glob, rel, norm(hit.fileName))) continue
            const id = `${rel}:${hit.lineNumber}:${hit.byteOffset}`
            if (seen.has(id)) continue
            seen.add(id)
            rows.push(item(hit))
            if (rows.length >= limit) break
          }

          if (!out.value.nextCursor) break
          cur = out.value.nextCursor
        }

        if (!rows.length && input.glob?.length) return yield* rip(input)

        remember(
          yield* InstanceState.get(state),
          dir,
          input.pattern,
          Array.from(new Set(rows.map((row) => path.join(dir, row.path.text)))),
        )

        return {
          items: rows,
          partial: false,
          engine: "fff" as const,
          regexFallbackError: err,
        }
      })

      const glob: Interface["glob"] = Effect.fn("Search.glob")(function* (input) {
        input.signal?.throwIfAborted()
        const dir = AppFileSystem.resolve(input.cwd)
        const limit = input.limit ?? 100
        const pick = yield* picker(dir).pipe(Effect.catch(() => Effect.succeed(undefined)))

        if (pick) {
          const out = yield* Effect.sync(() =>
            pick.fileSearch(include(input.pattern), {
              currentFile: path.join(dir, ".opencode"),
              pageIndex: 0,
              pageSize: Math.max(limit * 4, 200),
            }),
          )
          if (out.ok) {
            const rows = Array.from(
              new Set(
                out.value.items
                  .map((item) => norm(item.relativePath))
                  .filter((item) => !blocked(item))
                  .filter((item) => Glob.match(input.pattern, item) || Glob.match(input.pattern, base(item))),
              ),
            )
            if (rows.length > 0) {
              remember(
                yield* InstanceState.get(state),
                dir,
                input.pattern,
                rows.map((row) => path.join(dir, row)),
              )
              return {
                files: rows.slice(0, limit).map((row) => path.join(dir, row)),
                truncated: rows.length > limit,
              }
            }
          } else {
            log.warn("fff glob search failed", { dir, pattern: input.pattern, error: out.error })
          }
        }

        const rows = yield* rg.files({ cwd: dir, glob: [input.pattern], signal: input.signal }).pipe(
          Stream.take(limit + 1),
          Stream.runCollect,
          Effect.map((chunk) => [...chunk]),
        )
        const cut = rows.length > limit
        if (cut) rows.length = limit

        const out = yield* Effect.forEach(
          rows,
          Effect.fnUntraced(function* (file) {
            const full = path.join(dir, file)
            const info = yield* fs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
            const time =
              info?.mtime.pipe(
                Option.map((item) => item.getTime()),
                Option.getOrElse(() => 0),
              ) ?? 0
            return { file: full, time }
          }),
          { concurrency: 16 },
        )
        out.sort((a, b) => b.time - a.time)
        return {
          files: out.map((item) => item.file),
          truncated: cut,
        }
      })

      const open: Interface["open"] = Effect.fn("Search.open")(function* (input) {
        const st = yield* InstanceState.get(state)
        const file = input.cwd
          ? AppFileSystem.resolve(path.isAbsolute(input.file) ? input.file : path.join(input.cwd, input.file))
          : AppFileSystem.resolve(input.file)
        const idx = st.recent.findIndex((item) => item.files.includes(file))
        if (idx < 0) return

        const row = st.recent[idx]
        st.recent.splice(idx, 1)
        const pick = st.pick.get(row.dir)
        if (!pick) return

        const out = yield* Effect.sync(() => pick.trackQuery(row.text, file))
        if (!out.ok) {
          log.warn("fff track query failed", { dir: row.dir, query: row.text, file, error: out.error })
        }
      })

      return Service.of({ files, tree, search, file, glob, open })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Ripgrep.defaultLayer), Layer.provide(AppFileSystem.defaultLayer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export function files(input: Ripgrep.FilesInput) {
    return runPromise((svc) => Stream.toAsyncIterableEffect(svc.files(input)))
  }

  export function tree(input: Ripgrep.TreeInput) {
    return runPromise((svc) => svc.tree(input))
  }

  export function search(input: Ripgrep.SearchInput) {
    return runPromise((svc) => svc.search(input))
  }

  export function file(input: FileInput) {
    return runPromise((svc) => svc.file(input))
  }

  export function glob(input: GlobInput) {
    return runPromise((svc) => svc.glob(input))
  }

  export function open(input: { cwd?: string; file: string }) {
    return runPromise((svc) => svc.open(input))
  }
}
