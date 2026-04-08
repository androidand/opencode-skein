import { spawn } from "child_process"
import { Shell } from "@/shell/shell"
import { Tool } from "../tool"
import { Plugin } from "@/plugin"
import { ShellKind } from "./id"

const MAX_METADATA_LENGTH = 30_000

export function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return text.slice(0, MAX_METADATA_LENGTH) + "\n\n..."
}

export namespace ShellRunner {
  function preserveExitCode(command: string) {
    return `${command}
if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }
if ($?) { exit 0 }
exit 1`
  }

  export async function shellEnv(ctx: Tool.Context, cwd: string) {
    const extra = await Plugin.trigger("shell.env", { cwd, sessionID: ctx.sessionID, callID: ctx.callID }, { env: {} })
    return {
      ...process.env,
      ...extra.env,
    }
  }

  export function launch(shell: string, kind: ShellKind.ID, command: string, cwd: string, env: NodeJS.ProcessEnv) {
    if (process.platform === "win32" && ShellKind.powershell(kind)) {
      return spawn(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", preserveExitCode(command)], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        windowsHide: true,
      })
    }

    return spawn(command, {
      shell,
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: process.platform === "win32",
    })
  }

  export async function run(
    input: {
      shell: string
      kind: ShellKind.ID
      command: string
      cwd: string
      env: NodeJS.ProcessEnv
      timeout: number
      description: string
    },
    ctx: Tool.Context,
  ) {
    const proc = launch(input.shell, input.kind, input.command, input.cwd, input.env)
    let output = ""
    let code: number | null = null

    ctx.metadata({
      metadata: {
        output: "",
        description: input.description,
      },
    })

    proc.stdout?.setEncoding("utf8")
    proc.stderr?.setEncoding("utf8")

    const append = (chunk: string) => {
      output += chunk
      ctx.metadata({
        metadata: {
          output: preview(output),
          description: input.description,
        },
      })
    }

    proc.stdout?.on("data", append)
    proc.stderr?.on("data", append)

    let expired = false
    let aborted = false
    let exited = false
    let timer: ReturnType<typeof setTimeout>

    const kill = () => Shell.killTree(proc, { exited: () => exited })

    const abort = () => {
      aborted = true
      void kill()
    }

    const wait = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        ctx.abort.removeEventListener("abort", abort)
      }

      proc.once("exit", (next) => {
        exited = true
        code = next
      })

      proc.once("close", (next) => {
        exited = true
        code = next
        cleanup()
        resolve()
      })

      proc.once("error", (error) => {
        exited = true
        cleanup()
        reject(error)
      })
    })

    ctx.abort.addEventListener("abort", abort, { once: true })
    timer = setTimeout(() => {
      expired = true
      void kill()
    }, input.timeout + 100)

    if (ctx.abort.aborted) abort()

    await wait

    const metadata: string[] = []
    if (expired) metadata.push(`shell tool terminated command after exceeding timeout ${input.timeout} ms`)
    if (aborted) metadata.push("User aborted the command")
    if (metadata.length > 0) {
      output += "\n\n<shell_metadata>\n" + metadata.join("\n") + "\n</shell_metadata>"
    }

    return {
      title: input.description,
      metadata: {
        output: preview(output),
        exit: code,
        description: input.description,
      },
      output,
    }
  }
}
