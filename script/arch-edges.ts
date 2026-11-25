#!/usr/bin/env bun
// Prints the cross-package dependency edges of packages/*/src as a markdown
// table, using .dependency-cruiser.cjs. Exits 1 if the cruise is near-empty or
// any `@opencode-ai/*` import is unresolved: an unresolved workspace import is dropped from the graph, so
// the edge count would read low and the layering rules would pass vacuously.
import { $ } from "bun"

const out = await $`bunx --bun depcruise --config .dependency-cruiser.cjs --output-type json packages`.quiet().nothrow()
if (!out.stdout.length) {
  console.error(out.stderr.toString())
  process.exit(1)
}
const result = JSON.parse(out.stdout.toString()) as {
  modules: { source: string; dependencies: { module: string; resolved: string; couldNotResolve: boolean }[] }[]
}

const pkg = (path: string) => /^packages\/([^/]+)\//.exec(path)?.[1]
const edges = new Map<string, number>()
const unresolved = new Set<string>()
for (const mod of result.modules) {
  for (const dep of mod.dependencies) {
    if (dep.couldNotResolve) {
      if (dep.module.startsWith("@opencode-ai/")) unresolved.add(dep.module)
      continue
    }
    const from = pkg(mod.source)
    const to = pkg(dep.resolved)
    if (!from || !to || from === to) continue
    const key = `${from} -> ${to}`
    edges.set(key, (edges.get(key) ?? 0) + 1)
  }
}

// An empty or near-empty cruise means the scope filter is wrong, not that the
// monorepo has no dependencies; every rule passes vacuously on zero modules.
if (result.modules.length < 500 || edges.size === 0) {
  console.error(
    `cruise looks empty (${result.modules.length} modules, ${edges.size} cross-package edges): check exclude in .dependency-cruiser.cjs`,
  )
  process.exit(1)
}

if (unresolved.size) {
  console.error(`unresolved workspace imports (fix enhancedResolveOptions): ${[...unresolved].sort().join(", ")}`)
  process.exit(1)
}

console.log(`modules: ${result.modules.length}, cross-package edges: ${edges.size}\n`)
console.log("| from | to | imports |\n| --- | --- | ---: |")
for (const [key, count] of [...edges].sort(([a], [b]) => a.localeCompare(b))) {
  const [from, to] = key.split(" -> ")
  console.log(`| ${from} | ${to} | ${count} |`)
}
