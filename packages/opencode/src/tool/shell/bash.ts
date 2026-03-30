import { createShellTool } from "./util"

export const BashTool = createShellTool({
  id: "bash",
  shellName: "Bash",
  chaining:
    "use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`).",
  guidance: `# Bash shell notes
- This is a POSIX-compatible shell. Standard Unix conventions apply.
- Use double quotes for variable interpolation, single quotes for literal strings.
- Use \`$(...)\` for command substitution (not backticks).
- Redirect stderr with \`2>&1\` or \`2>/dev/null\`.`,
})
