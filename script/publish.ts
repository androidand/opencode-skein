#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { Effect } from "effect"
import { fileURLToPath } from "url"

console.log("=== publishing ===\n")

const tag = `v${Script.version}`
const pkgjsons = await Array.fromAsync(
  new Bun.Glob("**/package.json").scan({
    absolute: true,
  }),
).then((arr) => arr.filter((x) => !x.includes("node_modules") && !x.includes("dist")))
const extensionToml = fileURLToPath(new URL("../packages/extensions/zed/extension.toml", import.meta.url))

const readText = (path: string) => Effect.promise(() => Bun.file(path).text())
const writeText = (path: string, value: string) => Effect.promise(() => Bun.write(path, value))
const shell = <A>(run: () => Promise<A>) => Effect.promise(run)
const log = (message: string) => Effect.sync(() => console.log(message))

const hasChanges = shell(() => $`git diff --quiet && git diff --cached --quiet`.nothrow()).pipe(
  Effect.map((result) => result.exitCode !== 0),
)

const releaseTagExists = shell(() => $`git rev-parse -q --verify refs/tags/${tag}`.nothrow()).pipe(
  Effect.map((result) => result.exitCode === 0),
)

const prepareReleaseFiles = Effect.gen(function* () {
  yield* Effect.forEach(pkgjsons, (file) =>
    Effect.gen(function* () {
      const next = (yield* readText(file)).replaceAll(/"version": "[^"]+"/g, `"version": "${Script.version}"`)
      yield* log(`updated: ${file}`)
      yield* writeText(file, next)
    }),
  )

  const nextToml = (yield* readText(extensionToml))
    .replace(/^version = "[^"]+"/m, `version = "${Script.version}"`)
    .replaceAll(/releases\/download\/v[^/]+\//g, `releases/download/v${Script.version}/`)
  yield* log(`updated: ${extensionToml}`)
  yield* writeText(extensionToml, nextToml)
  yield* shell(() => $`bun install`)
  yield* shell(() => $`./packages/sdk/js/script/build.ts`)
})

const program = Effect.gen(function* () {
  if (Script.release && !Script.preview) {
    yield* shell(() => $`git fetch origin --tags`)
    yield* shell(() => $`git switch --detach`)
  }

  yield* prepareReleaseFiles

  if (Script.release && !Script.preview) {
    if (yield* releaseTagExists) yield* log(`release tag ${tag} already exists, skipping tag creation`)
    else {
      yield* shell(() => $`git commit -am "release: ${tag}"`)
      yield* shell(() => $`git tag ${tag}`)
      yield* shell(() => $`git push origin refs/tags/${tag} --no-verify`)
      yield* shell(() => new Promise((resolve) => setTimeout(resolve, 5_000)))
    }
  }

  yield* log("\n=== cli ===\n")
  yield* shell(() => import(`../packages/opencode/script/publish.ts`))
  yield* log("\n=== sdk ===\n")
  yield* shell(() => import(`../packages/sdk/js/script/publish.ts`))
  yield* log("\n=== plugin ===\n")
  yield* shell(() => import(`../packages/plugin/script/publish.ts`))

  if (Script.release) {
    yield* shell(() => import(`../packages/desktop/scripts/finalize-latest-json.ts`))
    yield* shell(() => import(`../packages/desktop-electron/scripts/finalize-latest-yml.ts`))
  }

  if (Script.release && !Script.preview) {
    yield* shell(() => $`git fetch origin`)
    yield* shell(() => $`git checkout -B dev origin/dev`)
    yield* prepareReleaseFiles
    if (yield* hasChanges) {
      yield* shell(() => $`git commit -am "sync release versions for v${Script.version}"`)
      yield* shell(() => $`git push origin HEAD:dev --no-verify`)
    } else yield* log(`dev already synced for ${tag}`)
  }

  if (Script.release) yield* shell(() => $`gh release edit ${tag} --draft=false --repo ${process.env.GH_REPO}`)
})

await Effect.runPromise(program)

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
