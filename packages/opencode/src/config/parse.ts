export * as ConfigParse from "./parse"

import { type ParseError as JsoncParseError, parse as parseJsoncImpl, printParseErrorCode } from "jsonc-parser"
import { Cause, Exit, Schema as EffectSchema, SchemaIssue } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import z from "zod"
import type { DeepMutable } from "@opencode-ai/core/schema"
import { InvalidError, JsonError } from "./error"

const log = Log.create({ service: "config.parse" })

type ZodSchema<T> = z.ZodType<T>

export function jsonc(text: string, filepath: string): unknown {
  const errors: JsoncParseError[] = []
  const data = parseJsoncImpl(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    const lines = text.split("\n")
    const issues = errors
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
      path: filepath,
      message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${issues}\n--- End ---`,
    })
  }

  return data
}

export function schema<T>(schema: ZodSchema<T>, data: unknown, source: string): T {
  const parsed = schema.safeParse(data)
  if (parsed.success) return parsed.data

  throw new InvalidError({
    path: source,
    issues: parsed.error.issues,
  })
}

export function effectSchema<S extends EffectSchema.Decoder<unknown, never>>(
  schema: S,
  data: unknown,
  source: string,
): DeepMutable<S["Type"]> {
  // The user's config lives on disk and may legitimately be stale, hand-edited,
  // or carry leftover keys from older versions. Crashing the whole load on a
  // single bad field would make opencode unstartable for those users (see Ben
  // Matthews / Discord, v1.14.45). Strip the malformed top-level fields and
  // keep going — log every drop so users can see what was ignored and fix it.
  const cleaned = stripUnknownTopLevelKeys(schema, data, source)
  return decodeWithFieldTolerance(schema, cleaned, source)
}

function stripUnknownTopLevelKeys(schema: EffectSchema.Top, data: unknown, source: string): unknown {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return data
  const extra = topLevelExtraKeys(schema, data)
  if (extra.length === 0) return data
  log.warn("ignoring unrecognized config keys", { source, keys: extra })
  const obj = data as Record<string, unknown>
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !extra.includes(key)))
}

function decodeWithFieldTolerance<S extends EffectSchema.Decoder<unknown, never>>(
  schema: S,
  data: unknown,
  source: string,
): DeepMutable<S["Type"]> {
  // Try a clean decode first. If it succeeds we're done — common path.
  const decoded = EffectSchema.decodeUnknownExit(schema)(data, { errors: "all", propertyOrder: "original" })
  if (Exit.isSuccess(decoded)) return decoded.value as DeepMutable<S["Type"]>
  const error = Cause.squash(decoded.cause)
  const issues = EffectSchema.isSchemaError(error)
    ? (SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues as z.core.$ZodIssue[])
    : ([{ code: "custom", message: String(error), path: [] }] as z.core.$ZodIssue[])

  // Identify malformed top-level fields. Anything with a non-empty path is a
  // field-scoped issue we can drop and retry. Issues with an empty path are
  // root-level (e.g. data is not an object at all) and can't be field-recovered.
  const badFields = collectTopLevelFieldNames(issues)
  if (badFields.size === 0 || typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new InvalidError({ path: source, issues }, { cause: error })
  }

  log.warn("ignoring invalid config fields", {
    source,
    fields: [...badFields],
    summary: issues
      .filter((issue) => issue.path && issue.path.length > 0)
      .map((issue) => `${issue.path?.join(".")}: ${issue.message}`)
      .slice(0, 8),
  })

  const obj = data as Record<string, unknown>
  const cleaned = Object.fromEntries(Object.entries(obj).filter(([key]) => !badFields.has(key)))
  // Retry without the bad fields. If THIS fails, we're past field-tolerance —
  // fall back to the original strict error so the user sees the real cause.
  const retry = EffectSchema.decodeUnknownExit(schema)(cleaned, { errors: "all", propertyOrder: "original" })
  if (Exit.isSuccess(retry)) return retry.value as DeepMutable<S["Type"]>
  throw new InvalidError({ path: source, issues }, { cause: error })
}

function collectTopLevelFieldNames(issues: z.core.$ZodIssue[]): Set<string> {
  const names = new Set<string>()
  for (const issue of issues) {
    const head = issue.path?.[0]
    if (typeof head === "string") names.add(head)
  }
  return names
}

function topLevelExtraKeys(schema: EffectSchema.Top, data: unknown) {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return []
  if (schema.ast._tag !== "Objects" || schema.ast.indexSignatures.length > 0) return []
  const known = new Set(schema.ast.propertySignatures.map((item) => String(item.name)))
  return Object.keys(data).filter((key) => !known.has(key))
}
