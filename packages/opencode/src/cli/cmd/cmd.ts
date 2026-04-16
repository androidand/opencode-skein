import type { CommandModule } from "yargs"

type WithDoubleDash<T> = T & { "--"?: string[] }

export function cmd<T, U>(input: CommandModule<T, WithDoubleDash<U>>) {
  return input
}

/**
 * Create a lazily-loaded command. The command metadata (name, describe,
 * builder options) is defined inline — lightweight and synchronous.
 * The handler dynamically imports the real command module only when
 * that specific command is invoked, avoiding loading heavy transitive
 * dependencies (AI SDKs, MCP, TUI, etc.) until needed.
 */
export function lazyCmd<T = {}, U = {}>(
  meta: {
    command: string
    describe: string
    builder?: CommandModule<T, WithDoubleDash<U>>["builder"]
  },
  load: () => Promise<{ handler: Function }>,
): CommandModule<T, WithDoubleDash<U>> {
  return {
    command: meta.command,
    describe: meta.describe,
    builder: meta.builder ?? ((yargs: any) => yargs),
    handler: async (args: any) => {
      const cmd = await load()
      return cmd.handler(args)
    },
  } as any
}
