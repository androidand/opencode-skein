import { createShellTool } from "./util"

export const BashTool = createShellTool(
  "bash",
  "Bash",
  "use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`).",
)
