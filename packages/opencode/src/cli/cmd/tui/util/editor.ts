import { defer } from "@/util/defer"
import { AppRuntime } from "@/effect/app-runtime"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Effect } from "effect"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliRenderer } from "@opentui/core"
import { Process } from "@/util/process"

export namespace Editor {
  export async function open(opts: { value: string; renderer: CliRenderer }): Promise<string | undefined> {
    const editor = process.env["VISUAL"] || process.env["EDITOR"]
    if (!editor) return

    const filepath = join(tmpdir(), `${Date.now()}.md`)
    const write = (content: string) =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          yield* fs.writeWithDirs(filepath, content)
        }),
      )
    const read = () =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          return yield* fs.readFileString(filepath)
        }),
      )
    await using _ = defer(async () => rm(filepath, { force: true }))

    await write(opts.value)
    opts.renderer.suspend()
    opts.renderer.currentRenderBuffer.clear()
    try {
      const parts = editor.split(" ")
      const proc = Process.spawn([...parts, filepath], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        shell: process.platform === "win32",
      })
      await proc.exited
      const content = await read()
      return content || undefined
    } finally {
      opts.renderer.currentRenderBuffer.clear()
      opts.renderer.resume()
      opts.renderer.requestRender()
    }
  }
}
