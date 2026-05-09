export * as ConfigReference from "./reference"

import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { zod } from "@/util/effect-zod"
import { parseRepositoryReference, repositoryCachePath } from "@/util/repository"
import { withStatics } from "@/util/schema"
import path from "path"

const Git = Schema.Struct({
  repository: Schema.String.annotate({
    description: "Git repository URL, host/path reference, or GitHub owner/repo shorthand",
  }),
  branch: Schema.optional(Schema.String).annotate({
    description: "Branch or ref Scout should clone and inspect",
  }),
})

const Local = Schema.Struct({
  path: Schema.String.annotate({
    description: "Absolute path, ~/ path, or workspace-relative path to a local reference directory",
  }),
})

export const Entry = Schema.Union([Schema.String, Git, Local]).annotate({ identifier: "ReferenceConfigEntry" })

export const Info = Schema.Record(Schema.String, Entry)
  .annotate({ identifier: "ReferenceConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export type Entry = Schema.Schema.Type<typeof Entry>
export type Resolved = { kind: "git"; repository: string; branch?: string } | { kind: "local"; path: string }

export const URL_PROTOCOL = "opencode-reference:"

type Context = {
  directory: string
  worktree: string
}

function referencePath(value: string, ctx: Context) {
  if (value.startsWith("~/")) return path.join(Global.Path.home, value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(ctx.worktree === "/" ? ctx.directory : ctx.worktree, value)
}

function cleanSubpath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "")
}

function safeJoin(root: string, subpath: string) {
  const filepath = path.resolve(root, cleanSubpath(subpath))
  const relative = path.relative(root, filepath)
  if (relative === "") return filepath
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return
  return filepath
}

export function resolve(reference: Entry, ctx: Context): Resolved {
  if (typeof reference === "string") {
    if (reference.startsWith(".") || reference.startsWith("/") || reference.startsWith("~")) {
      return { kind: "local", path: referencePath(reference, ctx) }
    }
    return { kind: "git", repository: reference }
  }
  if ("path" in reference) return { kind: "local", path: referencePath(reference.path, ctx) }
  return { kind: "git", repository: reference.repository, branch: reference.branch }
}

export function parseFilePath(value: string, references: Info | undefined) {
  const names = Object.keys(references ?? {}).toSorted((a, b) => b.length - a.length)
  for (const name of names) {
    if (value.startsWith(`${name}:/`)) return { name, path: cleanSubpath(value.slice(name.length + 2)) }
    if (value.startsWith(`${name}/`)) return { name, path: cleanSubpath(value.slice(name.length + 1)) }
  }
}

export function formatFilePath(name: string, subpath: string) {
  const cleaned = cleanSubpath(subpath)
  return `${name}:/${cleaned}`
}

export function resolveFilePath(input: { value: string; references: Info | undefined; ctx: Context }) {
  const parsed = parseFilePath(input.value, input.references)
  if (!parsed) return

  const entry = input.references?.[parsed.name]
  if (!entry) return

  const resolved = resolve(entry, input.ctx)
  const root =
    resolved.kind === "local"
      ? resolved.path
      : (() => {
          const reference = parseRepositoryReference(resolved.repository)
          if (!reference) return
          return repositoryCachePath(reference)
        })()
  if (!root) return

  const filepath = safeJoin(root, parsed.path)
  if (!filepath) return

  return { ...parsed, filepath, reference: resolved, root }
}

export function fileUrl(name: string, subpath: string) {
  return `opencode-reference://${encodeURIComponent(name)}/${cleanSubpath(subpath)
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`
}

export function filePathFromUrl(url: URL) {
  if (url.protocol !== URL_PROTOCOL) return
  return formatFilePath(decodeURIComponent(url.hostname), decodeURIComponent(url.pathname.slice(1)))
}
