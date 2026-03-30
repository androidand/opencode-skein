import { createShellTool } from "./util"

export const PowershellTool = createShellTool(
  "powershell",
  "Windows PowerShell",
  "avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }`",
)
