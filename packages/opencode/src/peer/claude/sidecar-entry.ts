// The actual script spawned as a real, separate OS process per opted-in
// opencode-skein session — see sidecar-manager.ts, which spawns this and
// reads its stdout. Talks to its parent over stdout only (one NDJSON event
// per line): `{"type":"ready",...}` once registered and listening, then
// `{"type":"inbound",...}` per message received from a real Claude Code
// peer. Never touches the opencode server's HTTP API or any credential for
// it — the parent process does the actual session injection, this process's
// only job is being a real, Claude-compatible peer.
import { fstatSync } from "fs"
import { startSidecar } from "./sidecar-server"

/** Upper bound on how long a sidecar may stay alive after it decides to stop. */
const STOP_TIMEOUT_MS = 5_000

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

  // The parent mirrors the owner session's status and title down this pipe so
  // the registry entry other processes read stays truthful — a session is
  // registered before it has a real title, and its status changes constantly.
  let stdinBuffer = ""
  process.stdin.on("data", (chunk: Buffer) => {
    stdinBuffer += chunk.toString("utf8")
    let newline: number
    while ((newline = stdinBuffer.indexOf("\n")) >= 0) {
      const line = stdinBuffer.slice(0, newline)
      stdinBuffer = stdinBuffer.slice(newline + 1)
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as { type?: string; status?: string; name?: string }
        if (event.type === "status" && (event.status === "idle" || event.status === "busy")) {
          void sidecar.setStatus(event.status).catch(() => undefined)
        } else if (event.type === "name" && typeof event.name === "string" && event.name) {
          void sidecar.setName(event.name).catch(() => undefined)
        }
      } catch {
        // ignore malformed control lines
      }
    }
  })
  process.stdin.on("error", () => undefined)

  // Whether stdin is a real pipe from the parent, or /dev/null because the
  // spawner passed stdio: "ignore". Decided once, before any listener can fire,
  // so a misdetection cannot kill a live sidecar.
  //
  // Not `isFIFO()`. Measured on Bun 1.3.14/macOS: a child spawned with
  // stdio: ["pipe"] reports isSocket()=true, isFIFO()=false (mode 140000), while
  // stdio: "ignore" reports isCharacterDevice()=true (mode 20000, /dev/null).
  // Bun gives the child a socketpair end, not a FIFO, so checking isFIFO()
  // silently disables this guard in production and only ever matches nothing.
  const stdinIsPipe = (() => {
    try {
      const s = fstatSync(process.stdin.fd ?? 0)
      return s.isSocket() || s.isFIFO()
    } catch {
      return false
    }
  })()

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(orphanCheck)
    // Bound the stop. `sidecar.stop()` closes the listening socket and removes
    // the registration; if that never settles (a hung close), the original
    // `.finally(process.exit)` never fires — and because `shuttingDown` is now
    // true, every later SIGTERM is swallowed and the process is unkillable
    // except by SIGKILL. So the exit is guaranteed on a timer rather than on
    // stop() settling.
    const bail = setTimeout(() => process.exit(0), STOP_TIMEOUT_MS)
    bail.unref()
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

  // The ppid guard above has a startup blind spot: it can only see a parent that
  // dies AFTER this line runs. If the parent is already gone by the time we read
  // `process.ppid`, the value captured here is the reparented one, the comparison
  // is false forever, and the sidecar survives indefinitely. Reproduced on
  // Bun 1.3.14/macOS: SIGKILL the parent before the child's first ppid read and
  // the child records ppid 1 and never notices.
  //
  // The parent's stdin pipe closes when the parent dies, at ANY point in our
  // lifetime, so EOF on a real pipe is a signal that cannot be missed by a
  // startup race. Registered after `orphanCheck` exists so `shutdown`'s
  // `clearInterval(orphanCheck)` cannot hit the temporal dead zone.
  //
  // Only when stdin is genuinely a pipe. `sidecar-manager.ts` spawns us with
  // `stdin: "pipe"`, but tests spawn with `stdio: "ignore"`, which hands us
  // /dev/null — that reads EOF immediately and would kill a perfectly healthy
  // sidecar on startup. A FIFO is the discriminator.
  if (stdinIsPipe) {
    process.stdin.on("end", shutdown)
    process.stdin.on("close", shutdown)
  }

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
