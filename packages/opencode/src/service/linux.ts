import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as ServicePlatform from "./platform"
import {
  buildUnixLauncher,
  chmodFile,
  quoteSystemd,
  UNIX_LAUNCHER,
  writeTextFile,
  ServiceError,
} from "./shared"
import path from "path"
import { Global } from "@/global"
import { ChildProcess } from "effect/unstable/process"
import { Stream } from "effect"

const SYSTEMD_SERVICE_NAME = "opencode.service"
const systemdUnitFile = path.join(path.dirname(Global.Path.config), "systemd", "user", SYSTEMD_SERVICE_NAME)

function buildLinuxUnit() {
  return [
    "[Unit]",
    "Description=OpenCode background server",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${quoteSystemd(UNIX_LAUNCHER)}`,
    "WorkingDirectory=%h",
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
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

    const install = Effect.fn("ServiceLinux.install")(function* (input) {
      yield* writeTextFile(fs, UNIX_LAUNCHER, buildUnixLauncher(input.command, input.password), 0o700)
      yield* chmodFile(fs, UNIX_LAUNCHER, 0o700)
      yield* writeTextFile(fs, systemdUnitFile, buildLinuxUnit())
      yield* run(["systemctl", "--user", "daemon-reload"])
      yield* run(["systemctl", "--user", "enable", "--now", SYSTEMD_SERVICE_NAME])
      yield* run(["systemctl", "--user", "restart", SYSTEMD_SERVICE_NAME])
      return { target: systemdUnitFile }
    })

    return ServicePlatform.Service.of({ install })
  }),
)
