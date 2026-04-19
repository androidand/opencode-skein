import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as ServicePlatform from "./platform"
import { buildWindowsLauncher, quoteWindowsArg, ServiceError, WINDOWS_LAUNCHER, writeTextFile } from "./shared"
import { ChildProcess } from "effect/unstable/process"
import { Stream } from "effect"

const WINDOWS_TASK_NAME = "OpenCode Service"

function buildWindowsTaskCommand() {
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    WINDOWS_LAUNCHER,
  ]
    .map(quoteWindowsArg)
    .join(" ")
}

export const layer: Layer.Layer<
  ServicePlatform.Service,
  never,
  ChildProcessSpawner.ChildProcessSpawner | AppFileSystem.Service
> = Layer.effect(
  ServicePlatform.Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const run = Effect.fnUntraced(
      function* (command: string[]) {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command[0], command.slice(1), { extendEnv: true, stdin: "ignore" }),
        )
        const [stdout, stderr] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
          { concurrency: 2 },
        )
        const code = yield* handle.exitCode
        if (code === 0) return { stdout, stderr }
        return yield* new ServiceError({
          message: stderr.trim() || stdout.trim() || `Command failed: ${command.join(" ")}`,
        })
      },
      Effect.scoped,
      Effect.catch((cause) => {
        if (cause instanceof ServiceError) return Effect.fail(cause)
        return Effect.fail(new ServiceError({ message: "Failed to execute service manager command", cause }))
      }),
    )

    const install = Effect.fn("ServiceWindows.install")(function* (input) {
      yield* writeTextFile(fs, WINDOWS_LAUNCHER, buildWindowsLauncher(input.command, input.password))
      yield* run(["schtasks", "/end", "/tn", WINDOWS_TASK_NAME]).pipe(Effect.catch(() => Effect.void))
      yield* run([
        "schtasks",
        "/create",
        "/tn",
        WINDOWS_TASK_NAME,
        "/sc",
        "onlogon",
        "/tr",
        buildWindowsTaskCommand(),
        "/f",
      ])
      yield* run(["schtasks", "/run", "/tn", WINDOWS_TASK_NAME]).pipe(Effect.catch(() => Effect.void))
      return { target: WINDOWS_TASK_NAME }
    })

    return ServicePlatform.Service.of({ install })
  }),
)
