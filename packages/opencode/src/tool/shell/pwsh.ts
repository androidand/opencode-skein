import { createShellTool } from "./util"

export const PwshTool = createShellTool(
  "pwsh",
  "PowerShell Core",
  "use a single PowerShell call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`).",
)
