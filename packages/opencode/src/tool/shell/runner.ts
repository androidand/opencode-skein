import { spawn } from "child_process"
import { Shell } from "@/shell/shell"
import { Tool } from "../tool"
import { Plugin } from "@/plugin"

const MAX_METADATA_LENGTH = 30_000

export function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return text.slice(0, MAX_METADATA_LENGTH) + "\n\n..."
}

export namespace ShellRunner {
  export async function shellEnv(ctx: Tool.Context, cwd: string) {
    const extra = await Plugin.trigger("shell.env", { cwd, sessionID: ctx.sessionID, callID: ctx.callID }, { env: {} })
    return {
      ...process.env,
      ...extra.env,
    }
  }

  export function launch(shell: string, name: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
    if (process.platform === "win32" && (name === "powershell" || name === "pwsh")) {
      return spawn(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
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
      name: string
      command: string
      cwd: string
      env: NodeJS.ProcessEnv
      timeout: number
      description: string
    },
    ctx: Tool.Context,
  ) {
    const proc = launch(input.shell, input.name, input.command, input.cwd, input.env)
    let output = ""

    ctx.metadata({
      metadata: {
        output: "",
        description: input.description,
      },
    })

    const append = (chunk: Buffer) => {
      output += chunk.toString()
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

    const kill = () => Shell.killTree(proc, { exited: () => exited })

    if (ctx.abort.aborted) {
      aborted = true
      await kill()
    }

    const abort = () => {
      aborted = true
      void kill()
    }

    ctx.abort.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => {
      expired = true
      void kill()
    }, input.timeout + 100)

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        ctx.abort.removeEventListener("abort", abort)
      }

      proc.once("exit", () => {
        exited = true
      })

      proc.once("close", () => {
        exited = true
        cleanup()
        resolve()
      })

      proc.once("error", (error) => {
        exited = true
        cleanup()
        reject(error)
      })
    })

    const metadata: string[] = []
    if (expired) metadata.push(`${input.name} tool terminated command after exceeding timeout ${input.timeout} ms`)
    if (aborted) metadata.push("User aborted the command")
    if (metadata.length > 0) {
      output += "\n\n<shell_metadata>\n" + metadata.join("\n") + "\n</shell_metadata>"
    }

    return {
      title: input.description,
      metadata: {
        output: preview(output),
        exit: proc.exitCode,
        description: input.description,
      },
      output,
    }
  }
}
