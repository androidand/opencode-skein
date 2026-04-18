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

const published = (name: string, version: string) =>
  Effect.promise(() => $`npm view ${name}@${version} version`.nothrow()).pipe(
    Effect.map((result) => result.exitCode === 0),
  )

const program = Effect.gen(function* () {
  yield* Effect.promise(() => $`bun tsc`)

  const pkg = (yield* Effect.promise(() => import("../package.json").then((m) => m.default))) as PackageJson
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

  yield* Effect.promise(() => Bun.write("package.json", JSON.stringify(next, null, 2)))
  yield* Effect.promise(() => $`bun pm pack && npm publish *.tgz --tag ${Script.channel} --access public`)
  yield* Effect.promise(() => Bun.write("package.json", JSON.stringify(pkg, null, 2)))
})

await Effect.runPromise(program)
