import z from "zod"
import { Tool } from "../tool"
import DESCRIPTION from "./shell.txt"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { Flag } from "@/flag/flag"
import { Shell } from "@/shell/shell"
import { resolvePath, formatShellDescription, askPermission } from "./util"
import { ShellParser } from "./parser"
import { ShellRunner } from "./runner"

export const log = Log.create({ service: "powershell-tool" })

const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000

const NAME = "powershell"

export const PowershellTool = Tool.define(NAME, async () => {
  const shell = Shell.acceptable()
  const name = Shell.name(shell)
  log.info("powershell tool using shell", { shell, name })

  return {
    description: formatShellDescription(DESCRIPTION, {
      name,
      shellName: "Windows PowerShell",
      chaining:
        "avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }`",
    }),
    parameters: z.object({
      command: z.string().describe("The command to execute"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of 'cd' commands.`,
        )
        .optional(),
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
    }),
    async execute(params, ctx) {
      const cwd = params.workdir ? await resolvePath(params.workdir, Instance.directory, shell) : Instance.directory
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT

      const scan = await ShellParser.collect({
        command: params.command,
        cwd,
        shell,
        shellType: NAME,
      })
      if (!Instance.containsPath(cwd)) scan.dirs.add(cwd)

      await askPermission(ctx, scan, NAME)

      return ShellRunner.run(
        {
          shell,
          name,
          command: params.command,
          cwd,
          env: await ShellRunner.shellEnv(ctx, cwd),
          timeout,
          description: params.description,
        },
        ctx,
      )
    },
  }
})
