#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { Effect } from "effect"

const tag = `v${Script.version}`
const sha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()
const betaPreview = Script.preview && Script.channel === "beta"

const changelog = Effect.promise(() => $`bun script/changelog.ts --to ${sha}`.cwd(process.cwd()))
const readNotes = Effect.promise(() => Bun.file(`${process.cwd()}/UPCOMING_CHANGELOG.md`).text()).pipe(
  Effect.catchAll(() => Effect.succeed("No notable changes")),
)
const writeOutput = (lines: ReadonlyArray<string>) =>
  process.env.GITHUB_OUTPUT
    ? Effect.promise(() => Bun.write(process.env.GITHUB_OUTPUT!, lines.join("\n")))
    : Effect.void

const createRelease = (notesFile?: string) => {
  if (!notesFile && betaPreview) {
    return Effect.promise(
      () => $`gh release create ${tag} -d --target ${sha} --title ${tag} --repo ${process.env.GH_REPO}`,
    )
  }
  if (notesFile)
    return Effect.promise(() => $`gh release create ${tag} -d --target ${sha} --title ${tag} --notes-file ${notesFile}`)
  return Effect.void
}

const viewRelease = betaPreview
  ? Effect.promise(() => $`gh release view ${tag} --json tagName,databaseId --repo ${process.env.GH_REPO}`.json())
  : Effect.promise(() => $`gh release view ${tag} --json tagName,databaseId`.json())

const output = Effect.gen(function* () {
  const lines = [`version=${Script.version}`]

  if (!Script.preview) {
    yield* changelog
    const body = yield* readNotes
    const notesFile = `${process.env.RUNNER_TEMP ?? "/tmp"}/opencode-release-notes.txt`
    yield* Effect.promise(() => Bun.write(notesFile, body))
    yield* createRelease(notesFile)
    const release = yield* viewRelease
    lines.push(`release=${release.databaseId}`, `tag=${release.tagName}`)
  } else if (Script.channel === "beta") {
    yield* createRelease()
    const release = yield* viewRelease
    lines.push(`release=${release.databaseId}`, `tag=${release.tagName}`)
  }

  lines.push(`repo=${process.env.GH_REPO}`)
  yield* writeOutput(lines)
})

await Effect.runPromise(output)
