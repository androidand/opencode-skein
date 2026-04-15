import path from "path"
import os from "os"
import z from "zod"
import { type ParseError as JsoncParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser"
import { Effect } from "effect"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { NamedError } from "@opencode-ai/shared/util/error"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { AppRuntime } from "@/effect/app-runtime"

async function withFs<A>(fn: (fs: AppFileSystem.Interface) => Effect.Effect<A, AppFileSystem.Error>) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      return yield* fn(fs)
    }),
  )
}

function missing(err: unknown) {
  if (typeof err !== "object" || err === null) return false
  if ("code" in err && err.code === "ENOENT") return true
  return (
    "reason" in err &&
    typeof err.reason === "object" &&
    err.reason !== null &&
    "_tag" in err.reason &&
    err.reason._tag === "NotFound"
  )
}

export namespace ConfigPaths {
  export async function projectFiles(name: string, directory: string, worktree: string) {
    return withFs(
      Effect.fn("ConfigPaths.projectFiles")(function* (fs) {
        const dirs = [directory]
        let dir = directory
        while (true) {
          if (worktree === dir) break
          const parent = path.dirname(dir)
          if (parent === dir) break
          dirs.push(parent)
          dir = parent
        }

        const out: string[] = []
        for (const dir of dirs.toReversed()) {
          for (const target of [`${name}.json`, `${name}.jsonc`]) {
            const file = path.join(dir, target)
            if (yield* fs.existsSafe(file)) out.push(file)
          }
        }
        return out
      }),
    )
  }

  export async function directories(directory: string, worktree: string) {
    return [
      Global.Path.config,
      ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
        ? await withFs((fs) =>
            fs.up({
              targets: [".opencode"],
              start: directory,
              stop: worktree,
            }),
          )
        : []),
      ...(await withFs((fs) =>
        fs.up({
          targets: [".opencode"],
          start: Global.Path.home,
          stop: Global.Path.home,
        }),
      )),
      ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
    ]
  }

  export function fileInDirectory(dir: string, name: string) {
    return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
  }

  export const JsonError = NamedError.create(
    "ConfigJsonError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
    }),
  )

  export const InvalidError = NamedError.create(
    "ConfigInvalidError",
    z.object({
      path: z.string(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
      message: z.string().optional(),
    }),
  )

  /** Read a config file, returning undefined for missing files and throwing JsonError for other failures. */
  export async function readFile(filepath: string) {
    return withFs((fs) => fs.readFileString(filepath)).catch((err: unknown) => {
      if (missing(err)) return
      throw new JsonError({ path: filepath }, { cause: err })
    })
  }

  type ParseSource = string | { source: string; dir: string }

  function source(input: ParseSource) {
    return typeof input === "string" ? input : input.source
  }

  function dir(input: ParseSource) {
    return typeof input === "string" ? path.dirname(input) : input.dir
  }

  /** Apply {env:VAR} and {file:path} substitutions to config text. */
  async function substitute(text: string, input: ParseSource, missing: "error" | "empty" = "error") {
    text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || ""
    })

    const fileMatches = Array.from(text.matchAll(/\{file:[^}]+\}/g))
    if (!fileMatches.length) return text

    const configDir = dir(input)
    const configSource = source(input)
    let out = ""
    let cursor = 0

    for (const match of fileMatches) {
      const token = match[0]
      const index = match.index!
      out += text.slice(cursor, index)

      const lineStart = text.lastIndexOf("\n", index - 1) + 1
      const prefix = text.slice(lineStart, index).trimStart()
      if (prefix.startsWith("//")) {
        out += token
        cursor = index + token.length
        continue
      }

      let filePath = token.replace(/^\{file:/, "").replace(/\}$/, "")
      if (filePath.startsWith("~/")) {
        filePath = path.join(os.homedir(), filePath.slice(2))
      }

      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
      const fileContent = (
        await withFs((fs) => fs.readFileString(resolvedPath)).catch((error: unknown) => {
          if (missing === "empty") return ""

          const errMsg = `bad file reference: "${token}"`
          if (missing(error)) {
            throw new InvalidError(
              {
                path: configSource,
                message: errMsg + ` ${resolvedPath} does not exist`,
              },
              { cause: error },
            )
          }
          throw new InvalidError({ path: configSource, message: errMsg }, { cause: error })
        })
      ).trim()

      out += JSON.stringify(fileContent).slice(1, -1)
      cursor = index + token.length
    }

    out += text.slice(cursor)
    return out
  }

  /** Substitute and parse JSONC text, throwing JsonError on syntax errors. */
  export async function parseText(text: string, input: ParseSource, missing: "error" | "empty" = "error") {
    const configSource = source(input)
    text = await substitute(text, input, missing)

    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const lines = text.split("\n")
      const errorDetails = errors
        .map((e) => {
          const beforeOffset = text.substring(0, e.offset).split("\n")
          const line = beforeOffset.length
          const column = beforeOffset[beforeOffset.length - 1].length + 1
          const problemLine = lines[line - 1]

          const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
          if (!problemLine) return error

          return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
        })
        .join("\n")

      throw new JsonError({
        path: configSource,
        message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}\n--- End ---`,
      })
    }

    return data
  }
}
