import { createShellTool } from "./util"

export const PowershellTool = createShellTool({
  id: "powershell",
  shellName: "Windows PowerShell 5.1",
  chaining:
    "avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success.",
  guidance: `# Windows PowerShell 5.1 shell notes
- This is Windows PowerShell 5.1 (legacy), NOT PowerShell 7+. It does NOT support \`&&\` or \`||\` pipeline chain operators.
- For conditional chaining use: \`cmd1; if ($?) { cmd2 }\`
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Cmdlets use Verb-Noun naming (e.g., \`Get-ChildItem\`, \`Set-Content\`). Common aliases like \`ls\`, \`cat\`, \`rm\` resolve to cmdlets with different behavior than Unix equivalents.
- Use \`$(...)\` for subexpressions. Use \`@(...)\` for array expressions.
- To call a native executable whose path contains spaces, use the call operator: \`& "path/to/exe" args\`.
- Escape special characters with backtick (\\\`) not backslash.
- Some modern PowerShell features (ternary operator, null-coalescing, etc.) are NOT available in 5.1.`,
})
