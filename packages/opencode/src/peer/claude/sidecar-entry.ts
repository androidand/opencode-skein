// The actual script spawned as a real, separate OS process per opted-in
// opencode-skein session — see sidecar-manager.ts, which spawns this and
// reads its stdout. Talks to its parent over stdout only (one NDJSON event
// per line): `{"type":"ready",...}` once registered and listening, then
// `{"type":"inbound",...}` per message received from a real Claude Code
// peer. Never touches the opencode server's HTTP API or any credential for
// it — the parent process does the actual session injection, this process's
// only job is being a real, Claude-compatible peer.
import { startSidecar } from "./sidecar-server"

export async function runSidecarEntry() {
  const ownerSessionID = process.env.OPENCODE_SIDECAR_OWNER_SESSION_ID
  if (!ownerSessionID) {
    console.error("OPENCODE_SIDECAR_OWNER_SESSION_ID is required")
    process.exitCode = 1
    return
  }
  const cwd = process.env.OPENCODE_SIDECAR_CWD ?? process.cwd()
  const name = process.env.OPENCODE_SIDECAR_NAME ?? "opencode-session"
  // Must be a root real Claude Code actually validates peer addresses
  // against, or `ListAgents`/`SendMessage` silently exclude the entry even
  // though its registry file is perfectly well-formed — confirmed live
  // (2026-09-17): registrations under a made-up `/tmp/opencode-cc-socks`
  // never appeared in `claude agents --json` at all. `/tmp/cc-socks` is the
  // root findings.md recorded and verified on darwin — every pid-named
  // socket file is unique, so sharing the directory with real Claude
  // sessions is safe. Linux's equivalent root
  // (`$XDG_RUNTIME_DIR/cc-socks`/`/run/user/<uid>/cc-socks`, per
  // findings.md) is not yet handled here.
  const socketDir = process.env.OPENCODE_SIDECAR_SOCKET_DIR ?? "/tmp/cc-socks"

  const sidecar = await startSidecar({
    ownerSessionID,
    cwd,
    name,
    socketDir,
    onMessage: (message) => {
      process.stdout.write(`${JSON.stringify({ type: "inbound", ...message })}\n`)
    },
  })

  process.stdout.write(`${JSON.stringify({ type: "ready", pid: sidecar.pid, socketPath: sidecar.socketPath })}\n`)

  // The parent mirrors the owner session's status down this pipe so the
  // registry entry other processes read says busy/idle truthfully.
  let stdinBuffer = ""
  process.stdin.on("data", (chunk: Buffer) => {
    stdinBuffer += chunk.toString("utf8")
    let newline: number
    while ((newline = stdinBuffer.indexOf("\n")) >= 0) {
      const line = stdinBuffer.slice(0, newline)
      stdinBuffer = stdinBuffer.slice(newline + 1)
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as { type?: string; status?: string }
        if (event.type === "status" && (event.status === "idle" || event.status === "busy")) {
          void sidecar.setStatus(event.status).catch(() => undefined)
        }
      } catch {
        // ignore malformed control lines
      }
    }
  })
  process.stdin.on("error", () => undefined)

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(orphanCheck)
    sidecar
      .stop()
      .catch(() => undefined)
      .finally(() => process.exit(0))
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  // `sidecar-manager.ts`'s spawning process is this sidecar's only reason
  // to exist — it's what turns an inbound message into a real prompt by
  // reading this process's stdout. If that parent dies without signalling
  // us first (a crash, a SIGKILL, or any stop that doesn't reach this
  // process), we'd otherwise keep running as a "ghost peer": still
  // discoverable, still able to authenticate a connection, but with no way
  // to deliver what it receives — silent message loss, not a visible
  // failure. `Process.spawn` children don't die with their parent on their
  // own, so detect the orphaning ourselves: a process is reparented (to pid
  // 1, or the nearest subreaper) once its original parent is gone, so a
  // `ppid` that changed from what it was at startup means exactly that.
  const originalPpid = process.ppid
  const orphanCheck = setInterval(() => {
    if (process.ppid !== originalPpid) shutdown()
  }, 2_000)
  orphanCheck.unref()

  // Never resolve on its own: when run as `debug claude-sidecar-entry`,
  // returning here would let `index.ts`'s `cli.parse()` complete, which
  // unconditionally force-exits the whole process afterward — confirmed
  // live as the actual cause of "sidecar exited" errors on every real TUI
  // launch. `shutdown()` exits directly, bypassing this.
  await new Promise<void>(() => {})
}

if (import.meta.main) {
  runSidecarEntry().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
