export namespace ShellKind {
  export const ids = ["bash", "pwsh", "powershell"] as const
  export type ID = (typeof ids)[number]

  const kind = new Set<string>(ids)
  const ps = new Set<string>(["pwsh", "powershell"])

  export function has(value: string): value is ID {
    return kind.has(value)
  }

  export function from(value: string): ID {
    return has(value) ? value : "bash"
  }

  export function powershell(value: string) {
    return ps.has(value)
  }
}

export namespace ShellToolID {
  export const id = "shell"
  export const legacy = "bash"
  export type ID = typeof id | typeof legacy

  const tool = new Set<string>([id, legacy])

  export function has(value: string): value is ID {
    return tool.has(value)
  }

  export function normalize(value: string) {
    return value === legacy ? id : value
  }
}
