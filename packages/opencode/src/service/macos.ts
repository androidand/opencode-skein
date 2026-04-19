import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as ServicePlatform from "./platform"
import {
  buildUnixLauncher,
  chmodFile,
  escapeXml,
  stderrLogFile,
  ServiceError,
  stdoutLogFile,
  UNIX_LAUNCHER,
  writeTextFile,
} from "./shared"
import { Global } from "@/global"
import path from "path"
import os from "os"
import { ChildProcess } from "effect/unstable/process"
import { Stream } from "effect"

const MAC_LABEL = "ai.opencode.service"
const macLaunchAgentFile = path.join(Global.Path.home, "Library", "LaunchAgents", `${MAC_LABEL}.plist`)

function buildLaunchAgent() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(MAC_LABEL)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${escapeXml(UNIX_LAUNCHER)}</string>`,
    "  </array>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>WorkingDirectory</key>",
    `  <string>${escapeXml(Global.Path.home)}</string>`,
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(stdoutLogFile)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(stderrLogFile)}</string>`,
    "</dict>",
    "</plist>",
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

    const install = Effect.fn("ServiceMacos.install")(function* (input) {
      const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid
      const domain = `gui/${uid}`

      yield* writeTextFile(fs, UNIX_LAUNCHER, buildUnixLauncher(input.command, input.password), 0o700)
      yield* chmodFile(fs, UNIX_LAUNCHER, 0o700)
      yield* writeTextFile(fs, macLaunchAgentFile, buildLaunchAgent())
      yield* run(["launchctl", "bootout", domain, macLaunchAgentFile]).pipe(Effect.catch(() => Effect.void))
      yield* run(["launchctl", "bootstrap", domain, macLaunchAgentFile])
      yield* run(["launchctl", "kickstart", "-k", `${domain}/${MAC_LABEL}`])
      return { target: macLaunchAgentFile }
    })

    return ServicePlatform.Service.of({ install })
  }),
)
