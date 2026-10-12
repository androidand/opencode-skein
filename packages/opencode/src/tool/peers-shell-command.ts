// Models habitually try to list peers by typing `peers` into the shell. There is
// no such command: `rtk peers` fails with a filesystem error, `peers` with
// "command not found", and `opencode peers` treats "peers" as a project path
// and launches a TUI that hangs until it is killed. None of those tell the
// model what to do, so it tries again. Seen in ~40 calls across 11 sessions.
//
// Only a single simple command (optionally piped, with redirections) matches;
// a compound command is left alone because something else in it is real.
const PEERS_COMMAND =
  /^\s*(?:timeout\s+\d+\s+)?(?:rtk\s+)?(?:(?:\S*\/)?opencode\s+)?peers(?:\s+--[\w-]+)*(?:\s+\d?>&?\S+)*\s*(?:\|[^;&]*)?$/

export function isPeersShellCommand(command: string): boolean {
  return PEERS_COMMAND.test(command)
}

export const PEERS_SHELL_MESSAGE =
  "Not run: `peers` is a tool, not a shell command. Call the `peers` tool directly (no arguments) to list " +
  "the other agent sessions on this machine, then use `send_peer_message` to reach one."
