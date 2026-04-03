export namespace ShellTool {
  export const ids = ["bash", "pwsh", "powershell"] as const
  export type ID = (typeof ids)[number]

  const shell = new Set<string>(ids)
  const ps = new Set<string>(["pwsh", "powershell"])

  export function has(value: string): value is ID {
    return shell.has(value)
  }

  export function from(value: string): ID {
    return has(value) ? value : "bash"
  }

  export function powershell(value: string) {
    return ps.has(value)
  }
}
