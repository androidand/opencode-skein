#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { Effect } from "effect"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

type PackageJson = {
  name: string
  version: string
  exports: Record<string, string>
}

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
      exports: Object.fromEntries(
        Object.entries(value.exports).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
    }
  }
  throw new Error("invalid plugin package manifest")
}

const published = (name: string, version: string) =>
  Effect.promise(() => $`npm view ${name}@${version} version`.nothrow()).pipe(
    Effect.map((result) => result.exitCode === 0),
  )

const withPackageJson = (
  pkg: PackageJson,
  next: { name: string; version: string; exports: Record<string, { import: string; types: string }> },
) =>
  Effect.promise(() => Bun.write("package.json", JSON.stringify(next, null, 2))).pipe(
    Effect.zipRight(Effect.promise(() => $`bun pm pack && npm publish *.tgz --tag ${Script.channel} --access public`)),
    Effect.ensuring(Effect.promise(() => Bun.write("package.json", JSON.stringify(pkg, null, 2)))),
  )

const program = Effect.gen(function* () {
  yield* Effect.promise(() => $`bun tsc`)

  const pkg = packageJson(yield* Effect.promise(() => import("../package.json").then((m) => m.default)))
  if (yield* published(pkg.name, pkg.version)) {
    console.log(`already published ${pkg.name}@${pkg.version}`)
    return
  }

  const next = {
    ...pkg,
    exports: Object.fromEntries(
      Object.entries(pkg.exports).map(([key, value]) => {
        const file = value.replace("./src/", "./dist/").replace(".ts", "")
        return [key, { import: file + ".js", types: file + ".d.ts" }]
      }),
    ),
  }

  yield* withPackageJson(pkg, next)
})

await Effect.runPromise(program)
