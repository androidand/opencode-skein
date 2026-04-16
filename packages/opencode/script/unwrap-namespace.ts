#!/usr/bin/env bun
/**
 * Unwrap a TypeScript `export namespace` into flat exports with self-reexport.
 *
 * Usage:
 *   bun script/unwrap-namespace.ts src/session/session.ts           # convert namespace
 *   bun script/unwrap-namespace.ts src/session/session.ts --dry-run
 *   bun script/unwrap-namespace.ts src/pty/index.ts --name service  # avoid filename collision
 *   bun script/unwrap-namespace.ts src/config/config.ts --retrofit  # already flat, add self-reexport
 *
 * Default mode:
 *   1. Finds `export namespace Foo { ... }` (ast-grep)
 *   2. Removes wrapper, dedents body, fixes self-references
 *   3. Appends `export * as Foo from "./file"` to the file (self-reexport)
 *   4. Rewrites consumer imports to point at the file directly
 *
 * Retrofit mode (--retrofit):
 *   File already has flat exports (from previous barrel migration).
 *   1. Reads the barrel index.ts to find the namespace name
 *   2. Adds `export * as Foo from "./file"` to the source file
 *   3. Rewrites consumers from barrel import to direct file import
 *
 * Does NOT create barrel index.ts files.
 *
 * Requires: ast-grep (`brew install ast-grep` or `cargo install ast-grep`)
 */

import path from "path"
import fs from "fs"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const retrofit = args.includes("--retrofit")
const nameFlag = args.find((a, i) => args[i - 1] === "--name")
const filePath = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--name")

if (!filePath) {
  console.error("Usage: bun script/unwrap-namespace.ts <file> [--dry-run] [--name <impl>] [--retrofit]")
  process.exit(1)
}

const absPath = path.resolve(filePath)
if (!fs.existsSync(absPath)) {
  console.error(`File not found: ${absPath}`)
  process.exit(1)
}

const srcRoot = path.resolve("src")
const dir = path.dirname(absPath)
const basename = path.basename(absPath, ".ts")

// ---------------------------------------------------------------------------
// Barrel map: parse an index.ts to get namespace→file mapping
// ---------------------------------------------------------------------------

function parseBarrelMap(indexPath: string): Record<string, string> {
  const map: Record<string, string> = {}
  if (!fs.existsSync(indexPath)) return map
  const content = fs.readFileSync(indexPath, "utf-8")
  const re = /export\s+\*\s+as\s+(\w+)\s+from\s+["']\.\/([^"']+)["']/g
  for (const m of content.matchAll(re)) {
    map[m[1]] = m[2].replace(/\.ts$/, "")
  }
  return map
}

// ---------------------------------------------------------------------------
// Retrofit mode: file is already flat, just add self-reexport + fix imports
// ---------------------------------------------------------------------------

if (retrofit) {
  const indexFile = path.join(dir, "index.ts")
  const barrelMap = parseBarrelMap(indexFile)

  // Find this file's namespace name from the barrel
  const relName = basename
  let nsName: string | undefined
  for (const [ns, file] of Object.entries(barrelMap)) {
    if (file === relName) {
      nsName = ns
      break
    }
  }

  if (!nsName) {
    console.error(`Could not find namespace for ${basename}.ts in ${indexFile}`)
    console.error("Barrel map:", barrelMap)
    process.exit(1)
  }

  console.log(`Retrofit: ${basename}.ts → add self-reexport as ${nsName}`)

  // Check if self-reexport already exists
  const content = fs.readFileSync(absPath, "utf-8")
  const selfReexport = `export * as ${nsName} from "./${basename}"`
  if (content.includes(selfReexport)) {
    console.log("Self-reexport already present, skipping file modification")
  } else if (!dryRun) {
    const trimmed = content.endsWith("\n") ? content : content + "\n"
    fs.writeFileSync(absPath, trimmed + selfReexport + "\n")
    console.log(`Added: ${selfReexport}`)
  } else {
    console.log(`Would add: ${selfReexport}`)
  }

  // Now rewrite consumers (same logic as default mode, below)
  rewriteConsumers(nsName, absPath, basename, dir)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Default mode: unwrap namespace
// ---------------------------------------------------------------------------

const src = fs.readFileSync(absPath, "utf-8")
const lines = src.split("\n")

const astResult = Bun.spawnSync(
  ["ast-grep", "run", "--pattern", "export namespace $NAME { $$$BODY }", "--lang", "typescript", "--json", absPath],
  { stdout: "pipe", stderr: "pipe" },
)

if (astResult.exitCode !== 0) {
  console.error("ast-grep failed:", astResult.stderr.toString())
  process.exit(1)
}

const matches = JSON.parse(astResult.stdout.toString()) as Array<{
  text: string
  range: { start: { line: number; column: number }; end: { line: number; column: number } }
  metaVariables: { single: Record<string, { text: string }>; multi: Record<string, Array<{ text: string }>> }
}>

if (matches.length === 0) {
  console.error("No `export namespace Foo { ... }` found. Use --retrofit for already-converted files.")
  process.exit(1)
}

if (matches.length > 1) {
  console.error(`Found ${matches.length} namespaces — this script handles one at a time`)
  for (const m of matches) console.error(`  ${m.metaVariables.single.NAME.text} (line ${m.range.start.line + 1})`)
  process.exit(1)
}

const match = matches[0]
const nsName = match.metaVariables.single.NAME.text
const nsLine = match.range.start.line
const closeLine = match.range.end.line

console.log(`Found: export namespace ${nsName} { ... }`)
console.log(`  Lines ${nsLine + 1}–${closeLine + 1} (${closeLine - nsLine + 1} lines)`)

// Unwrap: remove namespace wrapper, dedent body
const before = lines.slice(0, nsLine)
const body = lines.slice(nsLine + 1, closeLine)
const after = lines.slice(closeLine + 1)

const dedented = body.map((line) => {
  if (line === "") return ""
  if (line.startsWith("  ")) return line.slice(2)
  return line
})

let newContent = [...before, ...dedented, ...after].join("\n")

// Fix self-references (Foo.Bar → Bar when Bar is exported from this file)
const exportedNames = new Set<string>()
const exportRegex = /export\s+(?:const|function|class|interface|type|enum|abstract\s+class)\s+(\w+)/g
for (const line of dedented) {
  for (const m of line.matchAll(exportRegex)) exportedNames.add(m[1])
}
const reExportRegex = /export\s*\{\s*([^}]+)\}/g
for (const line of dedented) {
  for (const m of line.matchAll(reExportRegex)) {
    for (const name of m[1].split(",")) {
      const trimmed = name
        .trim()
        .split(/\s+as\s+/)
        .pop()!
        .trim()
      if (trimmed) exportedNames.add(trimmed)
    }
  }
}

let selfRefCount = 0
if (exportedNames.size > 0) {
  const fixedLines = newContent.split("\n").map((line) => {
    const segments: Array<{ text: string; isString: boolean }> = []
    let i = 0
    let current = ""
    let inString: string | null = null

    while (i < line.length) {
      const ch = line[i]
      if (inString) {
        current += ch
        if (ch === "\\" && i + 1 < line.length) {
          current += line[i + 1]
          i += 2
          continue
        }
        if (ch === inString) {
          segments.push({ text: current, isString: true })
          current = ""
          inString = null
        }
        i++
        continue
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        if (current) segments.push({ text: current, isString: false })
        current = ch
        inString = ch
        i++
        continue
      }
      if (ch === "/" && i + 1 < line.length && line[i + 1] === "/") {
        current += line.slice(i)
        segments.push({ text: current, isString: true })
        current = ""
        i = line.length
        continue
      }
      current += ch
      i++
    }
    if (current) segments.push({ text: current, isString: !!inString })

    return segments
      .map((seg) => {
        if (seg.isString) return seg.text
        let result = seg.text
        for (const name of exportedNames) {
          const pattern = `${nsName}.${name}`
          while (result.includes(pattern)) {
            const idx = result.indexOf(pattern)
            const charBefore = idx > 0 ? result[idx - 1] : " "
            const charAfter = idx + pattern.length < result.length ? result[idx + pattern.length] : " "
            if (/\w/.test(charBefore) || /\w/.test(charAfter)) break
            result = result.slice(0, idx) + name + result.slice(idx + pattern.length)
            selfRefCount++
          }
        }
        return result
      })
      .join("")
  })
  newContent = fixedLines.join("\n")
}

// Handle index.ts rename
const isIndex = basename === "index"
const implName = nameFlag ?? (isIndex ? nsName.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase() : basename)
const implFile = isIndex ? path.join(dir, `${implName}.ts`) : absPath

// Add self-reexport at the bottom
const selfReexport = `export * as ${nsName} from "./${implName}"`
if (!newContent.endsWith("\n")) newContent += "\n"
newContent += selfReexport + "\n"

console.log("")
if (isIndex) {
  console.log(`Plan: rename index.ts → ${implName}.ts, add self-reexport`)
} else {
  console.log(`Plan: unwrap in place, add self-reexport`)
}
if (selfRefCount > 0) console.log(`Fixed ${selfRefCount} self-reference(s) (${nsName}.X → X)`)

if (dryRun) {
  console.log("")
  console.log("--- DRY RUN ---")
  console.log("")
  console.log(`=== ${implName}.ts (first 20 lines) ===`)
  newContent
    .split("\n")
    .slice(0, 20)
    .forEach((l, i) => console.log(`  ${i + 1}: ${l}`))
  console.log("  ...")
  console.log("")
  console.log(`=== last 5 lines ===`)
  const allLines = newContent.split("\n")
  allLines.slice(-5).forEach((l, i) => console.log(`  ${allLines.length - 4 + i}: ${l}`))
  console.log("")
  rewriteConsumers(nsName, implFile, implName, dir)
} else {
  if (isIndex) {
    fs.writeFileSync(implFile, newContent)
    fs.unlinkSync(absPath)
    console.log(`Renamed to ${implName}.ts (${newContent.split("\n").length} lines)`)
  } else {
    fs.writeFileSync(absPath, newContent)
    console.log(`Rewrote ${basename}.ts (${newContent.split("\n").length} lines)`)
  }
  rewriteConsumers(nsName, implFile, implName, dir)
}

// ---------------------------------------------------------------------------
// Consumer import rewriting (shared by default + retrofit mode)
// ---------------------------------------------------------------------------

function rewriteConsumers(nsName: string, implFile: string, implName: string, dir: string) {
  const relImplFromSrc = path.relative(srcRoot, implFile).replace(/\.ts$/, "")
  const barrelMap = parseBarrelMap(path.join(dir, "index.ts"))

  // Find all files that reference the namespace name
  const searchDirs = ["src", "test", "script"].filter((d) => fs.existsSync(d))
  const rgResult = Bun.spawnSync(["rg", "-l", nsName, ...searchDirs, "--type", "ts"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const candidates = rgResult.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((f) => f.length > 0)

  let totalChanges = 0
  const changedFiles: string[] = []

  for (const file of candidates) {
    const absFile = path.resolve(file)
    if (absFile === path.resolve(implFile) || absFile === path.resolve(absPath)) continue

    let content = fs.readFileSync(file, "utf-8")
    let changes = 0

    // Match: import { Foo } or import { Foo, Bar } or import type { Foo }
    const importRe = /^(import\s+(?:type\s+)?)\{\s*([^}]+)\}\s*from\s*["']([^"']+)["']/gm

    content = content.replace(importRe, (original, prefix: string, names: string, importPath: string) => {
      const nameList = names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)

      // Check if this namespace is among the imported names
      const nsEntry = nameList.find((n) => n.split(/\s+as\s+/)[0].trim() === nsName)
      if (!nsEntry) return original

      // Check if this import resolves to our directory (barrel) or our file
      const resolved = resolveImportPath(importPath, file)
      if (!resolved) return original

      const resolvedAbs = path.resolve(resolved)
      const isBarrelImport =
        resolvedAbs === dir || resolvedAbs === path.join(dir, "index.ts") || resolvedAbs === path.join(dir, "index")
      const isDirectImport = resolvedAbs === implFile.replace(/\.ts$/, "") || resolvedAbs === implFile

      if (!isBarrelImport && !isDirectImport) return original

      // If it's already a direct import with just this name, nothing to change
      if (isDirectImport && nameList.length === 1) return original

      // Build the correct import path for the impl file
      const newImportPath = computeImportPath(file, implFile)

      if (nameList.length === 1) {
        // Simple: just repoint to the file
        changes++
        return `${prefix}{ ${nsEntry} } from "${newImportPath}"`
      }

      // Multi-import: split into separate lines
      const newLines: string[] = []
      for (const n of nameList) {
        const imported = n.split(/\s+as\s+/)[0].trim()

        if (imported === nsName) {
          newLines.push(`${prefix}{ ${n} } from "${newImportPath}"`)
          changes++
        } else if (barrelMap[imported]) {
          // Another namespace from the same barrel
          const otherFile = path.join(dir, barrelMap[imported] + ".ts")
          const otherPath = computeImportPath(file, otherFile)
          newLines.push(`${prefix}{ ${n} } from "${otherPath}"`)
          changes++
        } else {
          // Unknown — keep original path
          newLines.push(`${prefix}{ ${n} } from "${importPath}"`)
        }
      }
      return newLines.join("\n")
    })

    // Fix dynamic imports: const { Foo } = await import("...")
    const dynRe = new RegExp(
      `(const|let|var)\\s+\\{\\s*${nsName}\\s*\\}\\s*=\\s*await\\s+import\\(\\s*["']([^"']+)["']\\s*\\)`,
      "g",
    )
    content = content.replace(dynRe, (original, decl, importPath) => {
      const resolved = resolveImportPath(importPath, file)
      if (!resolved) return original
      const resolvedAbs = path.resolve(resolved)
      const isTarget =
        resolvedAbs === dir ||
        resolvedAbs === path.join(dir, "index.ts") ||
        resolvedAbs === path.join(dir, "index") ||
        resolvedAbs === implFile.replace(/\.ts$/, "") ||
        resolvedAbs === implFile
      if (!isTarget) return original
      const newPath = computeImportPath(file, implFile)
      changes++
      return `${decl} ${nsName} = await import("${newPath}")`
    })

    if (changes > 0) {
      if (!dryRun) fs.writeFileSync(file, content)
      changedFiles.push(file)
      totalChanges += changes
    }
  }

  console.log("")
  if (totalChanges > 0) {
    console.log(`${dryRun ? "Would rewrite" : "Rewrote"} ${totalChanges} import(s) in ${changedFiles.length} file(s):`)
    for (const f of changedFiles) console.log(`  ${f}`)
  } else {
    console.log("No import rewrites needed")
  }

  console.log("")
  console.log("=== Verify ===")
  console.log("")
  console.log("bunx --bun tsgo --noEmit                                # typecheck")
  console.log("bun run --conditions=browser ./src/index.ts generate    # circular import check")
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

function resolveImportPath(importPath: string, fromFile: string): string | null {
  if (importPath.startsWith("@/")) return path.join(srcRoot, importPath.slice(2))
  if (importPath.startsWith(".")) return path.resolve(path.dirname(fromFile), importPath)
  return null
}

function computeImportPath(fromFile: string, toFile: string): string {
  const fromAbs = path.resolve(fromFile)
  if (fromAbs.startsWith(srcRoot + "/")) {
    return `@/${path.relative(srcRoot, toFile).replace(/\.ts$/, "")}`
  }
  let rel = path.relative(path.dirname(fromAbs), toFile).replace(/\.ts$/, "")
  if (!rel.startsWith(".")) rel = "./" + rel
  return rel
}
