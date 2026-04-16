#!/usr/bin/env bun
/**
 * Rollup tree-shaking pre-pass for the opencode build.
 *
 * Bun's bundler cannot tree-shake `export * as X from "./mod"` barrels
 * (nor can esbuild — see evanw/esbuild#1420). Rollup can.
 *
 * This script runs Rollup on the source entrypoints to eliminate unused
 * exports and their transitive imports, then writes the tree-shaken ESM
 * to .rollup-tmp/ for Bun to compile into the final binary.
 *
 * Usage:
 *   bun script/treeshake-prepass.ts [entrypoints...]
 *
 * If no entrypoints are given, defaults to ./src/index.ts.
 * Output goes to .rollup-tmp/ preserving the entry filename.
 */

import { rollup, type Plugin as RollupPlugin } from "rollup"
import path from "path"
import fs from "fs"

const dir = path.resolve(import.meta.dirname, "..")
const srcDir = path.join(dir, "src")

// Path alias mappings from tsconfig.json
const aliases: Record<string, string> = {
  "@/": path.join(srcDir, "/"),
  "@tui/": path.join(srcDir, "cli/cmd/tui/"),
}

// Conditional imports from package.json "#imports"
const hashImports: Record<string, string> = {
  "#db": path.join(srcDir, "storage/db.bun.ts"),
  "#pty": path.join(srcDir, "pty/pty.bun.ts"),
  "#hono": path.join(srcDir, "server/adapter.bun.ts"),
}

function resolveWithAliases(source: string, importerDir: string): string | null {
  // Handle hash imports
  if (hashImports[source]) return hashImports[source]

  // Handle path aliases
  for (const [alias, target] of Object.entries(aliases)) {
    if (source.startsWith(alias)) {
      return target + source.slice(alias.length)
    }
  }

  // Handle relative imports
  if (source.startsWith(".")) {
    return path.resolve(importerDir, source)
  }

  return null
}

// Binary/asset extensions that Bun imports natively but Rollup can't parse
const assetExtensions = new Set([".wav", ".wasm", ".node", ".png", ".jpg", ".gif", ".svg", ".css"])

function tryResolveFile(base: string): string | null {
  // Try exact file, then .ts, then .tsx, then /index.ts, then /index.tsx
  for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const p = base + suffix
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
  }
  // Bun.Transpiler rewrites .ts → .js in import paths, so try .ts for .js
  if (base.endsWith(".js")) {
    const tsBase = base.slice(0, -3)
    for (const suffix of [".ts", ".tsx"]) {
      const p = tsBase + suffix
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
    }
  }
  return null
}

/**
 * Rollup plugin that resolves TypeScript paths and transpiles TS/TSX.
 * Uses Bun.Transpiler for speed — no separate TS compilation step.
 */
const bunTranspilePlugin: RollupPlugin = {
  name: "bun-transpile",

  resolveId(source, importer) {
    if (!importer) return null

    const importerDir = path.dirname(importer)
    const resolved = resolveWithAliases(source, importerDir)
    if (!resolved) return null // external (node_modules, node builtins)

    const file = tryResolveFile(resolved)
    if (file) return file

    // If it's a local import we can't resolve (generated file, missing, etc.),
    // mark it external so Bun handles it later
    return { id: source, external: true }
  },

  load(id) {
    if (id.endsWith(".ts") || id.endsWith(".tsx")) {
      return fs.readFileSync(id, "utf-8")
    }
    // Handle non-JS assets that Bun imports natively
    if (id.endsWith(".txt")) {
      const content = fs.readFileSync(id, "utf-8")
      return `export default ${JSON.stringify(content)};`
    }
    if (id.endsWith(".json")) {
      const content = fs.readFileSync(id, "utf-8")
      return `export default ${content};`
    }
    if (id.endsWith(".sql")) {
      const content = fs.readFileSync(id, "utf-8")
      return `export default ${JSON.stringify(content)};`
    }
    // Binary assets — return a placeholder (Bun handles the real import)
    const ext = path.extname(id)
    if (assetExtensions.has(ext)) {
      return `export default "asset:${path.basename(id)}";`
    }
    return null
  },

  transform(code, id) {
    if (!id.endsWith(".ts") && !id.endsWith(".tsx")) return null
    const loader = id.endsWith(".tsx") ? "tsx" : "ts"
    const t = new Bun.Transpiler({ loader, tsconfig: JSON.stringify({ compilerOptions: { jsx: "preserve" } }) })
    return { code: t.transformSync(code), map: null }
  },
}

export async function treeshakePrepass(entrypoints: string[], outDir: string) {
  const absEntries = entrypoints.map((e) => path.resolve(dir, e))
  const startTime = performance.now()

  console.log(`[treeshake] Running Rollup pre-pass on ${absEntries.length} entrypoint(s)...`)

  const bundle = await rollup({
    input: absEntries,
    plugins: [bunTranspilePlugin],
    treeshake: {
      moduleSideEffects: false, // equivalent to sideEffects: false
    },
    // Mark everything that isn't local source as external.
    // Bun handles node_modules resolution + bundling in the compile step.
    external: (id) => {
      if (id.startsWith(".") || id.startsWith("/") || id.startsWith("@/") || id.startsWith("@tui/") || id.startsWith("#"))
        return false
      return true
    },
    logLevel: "warn",
  })

  fs.mkdirSync(outDir, { recursive: true })
  const { output } = await bundle.write({
    dir: outDir,
    format: "esm",
    preserveModules: false,
    entryFileNames: "[name].js",
  })
  await bundle.close()

  const elapsed = (performance.now() - startTime).toFixed(0)
  const totalSize = output.reduce((sum, chunk) => sum + ("code" in chunk ? chunk.code.length : 0), 0)
  console.log(`[treeshake] Done in ${elapsed}ms — ${output.length} chunks, ${(totalSize / 1024).toFixed(0)}KB total`)

  // Return a mapping of original entry basenames to output paths
  const entryMap = new Map<string, string>()
  for (const chunk of output) {
    if (chunk.type === "chunk" && chunk.isEntry) {
      entryMap.set(chunk.name, path.join(outDir, chunk.fileName))
    }
  }
  return entryMap
}

// CLI mode: run directly
if (import.meta.main) {
  const args = process.argv.slice(2)
  const entries = args.length > 0 ? args : ["./src/index.ts"]
  const outDir = path.join(dir, ".rollup-tmp")
  const result = await treeshakePrepass(entries, outDir)
  for (const [name, out] of result) {
    console.log(`  ${name} → ${path.relative(dir, out)}`)
  }
}
