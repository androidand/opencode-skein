import { describe, expect, test } from "bun:test"
import { isPeersShellCommand } from "@/tool/peers-shell-command"

describe("isPeersShellCommand", () => {
  // Each of these was run by a model in a real session and answered with a
  // filesystem error, "command not found", or a hung `opencode` launch.
  test.each([
    "peers",
    "rtk peers",
    "rtk peers 2>&1 | head -20",
    "peers 2>&1 | rtk grep -i 'tanto\\|rco'",
    "rtk opencode peers 2>&1 | head -20",
    "~/.local/bin/opencode peers --json 2>&1 | head -30",
    "timeout 5 ~/.local/bin/opencode peers 2>&1",
    "rtk peers 2>/dev/null | head -30",
  ])("matches %s", (command) => expect(isPeersShellCommand(command)).toBe(true))

  test.each([
    "grep peers file.txt",
    "git log --author=peers",
    "ls peers/",
    "echo peers",
    "rtk git status",
    "peers-tool --help",
    "cd /x && peers",
    "opencode run 'list peers'",
  ])("does not match %s", (command) => expect(isPeersShellCommand(command)).toBe(false))
})
