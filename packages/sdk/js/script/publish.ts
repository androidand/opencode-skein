#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { Effect } from "effect"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const packageJson = (value: unknown) => {
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "version" in value &&
    typeof value.version === "string" &&
    "exports" in value &&
    typeof value.exports === "object" &&
    value.exports !== null
  ) {
    return {
      name: value.name,
      version: value.version,
      exports: value.exports,
    }
  }
  throw new Error("invalid sdk package manifest")
}

const published = (name: string, version: string) =>
  Effect.promise(() => $`npm view ${name}@${version} version`.nothrow()).pipe(
    Effect.map((result) => result.exitCode === 0),
  )

const withPackageJson = (pkg: ReturnType<typeof packageJson>, next: ReturnType<typeof packageJson>) =>
  Effect.promise(() => Bun.write("package.json", JSON.stringify(next, null, 2))).pipe(
    Effect.zipRight(Effect.promise(() => $`bun pm pack`)),
    Effect.zipRight(Effect.promise(() => $`npm publish *.tgz --tag ${Script.channel} --access public`)),
    Effect.ensuring(Effect.promise(() => Bun.write("package.json", JSON.stringify(pkg, null, 2)))),
  )

function transformExports(exports: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(exports).map(([key, value]) => {
      if (typeof value === "string") {
        const file = value.replace("./src/", "./dist/").replace(".ts", "")
        return [key, { import: file + ".js", types: file + ".d.ts" }]
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return [key, transformExports(value)]
      return [key, value]
    }),
  )
}

const program = Effect.gen(function* () {
  const pkg = packageJson(yield* Effect.promise(() => import("../package.json").then((m) => m.default)))
  if (yield* published(pkg.name, pkg.version)) {
    console.log(`already published ${pkg.name}@${pkg.version}`)
    return
  }

  const next = {
    ...pkg,
    exports: transformExports(pkg.exports),
  }

  yield* withPackageJson(pkg, next)
})

await Effect.runPromise(program)
