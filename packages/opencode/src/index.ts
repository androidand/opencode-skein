import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { lazyCmd } from "./cli/cmd/cmd"
import { Log } from "./util"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { InstallationVersion } from "./installation/version"
import { NamedError } from "@opencode-ai/shared/util/error"
import { FormatError } from "./cli/error"
import { Filesystem } from "./util"
import { EOL } from "os"
import path from "path"
import { Global } from "./global"
import { JsonMigration } from "./storage"
import { Database } from "./storage"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
import { drizzle } from "drizzle-orm/bun-sqlite"

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

// Shared network options used by TUI, serve, acp, web commands
const networkOptions = {
  port: { type: "number" as const, describe: "port to listen on", default: 0 },
  hostname: { type: "string" as const, describe: "hostname to listen on", default: "127.0.0.1" },
  mdns: { type: "boolean" as const, describe: "enable mDNS service discovery (defaults hostname to 0.0.0.0)", default: false },
  "mdns-domain": { type: "string" as const, describe: "custom domain name for mDNS service (default: opencode.local)", default: "opencode.local" },
  cors: { type: "string" as const, array: true as const, describe: "additional domains to allow for CORS", default: [] as string[] },
} as const

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)

    Log.Default.info("opencode", {
      version: InstallationVersion,
      args: process.argv.slice(2),
    })

    const marker = path.join(Global.Path.data, "opencode.db")
    if (!(await Filesystem.exists(marker))) {
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")

  // ── Default command (TUI) ──
  .command(lazyCmd(
    {
      command: "$0 [project]",
      describe: "start opencode tui",
      builder: (yargs: any) =>
        yargs.options(networkOptions)
          .positional("project", { type: "string", describe: "path to start opencode in" })
          .option("model", { type: "string", alias: ["m"], describe: "model to use in the format of provider/model" })
          .option("continue", { alias: ["c"], describe: "continue the last session", type: "boolean" })
          .option("session", { alias: ["s"], type: "string", describe: "session id to continue" })
          .option("fork", { type: "boolean", describe: "fork the session when continuing (use with --continue or --session)" })
          .option("prompt", { type: "string", describe: "prompt to use" })
          .option("agent", { type: "string", describe: "agent to use" }),
    },
    () => import("./cli/cmd/tui/thread").then((m) => m.TuiThreadCommand),
  ))

  // ── Heavy commands — lazy-loaded handlers ──
  .command(lazyCmd(
    {
      command: "run [message..]",
      describe: "run opencode with a message",
      builder: (yargs: any) =>
        yargs
          .positional("message", { describe: "message to send", type: "string", array: true, default: [] })
          .option("command", { describe: "the command to run, use message for args", type: "string" })
          .option("continue", { alias: ["c"], describe: "continue the last session", type: "boolean" })
          .option("session", { alias: ["s"], describe: "session id to continue", type: "string" })
          .option("fork", { type: "boolean", describe: "fork the session before continuing" })
          .option("share", { type: "boolean", describe: "share the session" })
          .option("model", { alias: ["m"], describe: "model to use", type: "string" })
          .option("agent", { describe: "agent to use", type: "string" })
          .option("format", { describe: "format", type: "string", choices: ["default", "json"], default: "default" })
          .option("file", { alias: ["f"], describe: "file(s) to attach", type: "string", array: true })
          .option("title", { describe: "title for the session", type: "string" })
          .option("attach", { describe: "attach to a running opencode server", type: "string" })
          .option("password", { alias: ["p"], describe: "basic auth password", type: "string" })
          .option("dir", { describe: "directory to run in", type: "string" })
          .option("port", { describe: "port for the local server", type: "number" })
          .option("variant", { describe: "model variant", type: "string" })
          .option("thinking", { describe: "show thinking blocks", type: "boolean", default: false })
          .option("dangerously-skip-permissions", { describe: "auto-approve permissions", type: "boolean", default: false }),
    },
    () => import("./cli/cmd/run").then((m) => m.RunCommand),
  ))
  .command(lazyCmd(
    {
      command: "attach <url>",
      describe: "attach to a running opencode server",
      builder: (yargs: any) =>
        yargs
          .positional("url", { describe: "http://localhost:4096", type: "string", demandOption: true })
          .option("dir", { describe: "directory to run in", type: "string" })
          .option("continue", { alias: ["c"], describe: "continue the last session", type: "boolean" })
          .option("session", { alias: ["s"], describe: "session id to continue", type: "string" })
          .option("fork", { type: "boolean", describe: "fork the session when continuing" })
          .option("password", { alias: ["p"], describe: "basic auth password", type: "string" }),
    },
    () => import("./cli/cmd/tui/attach").then((m) => m.AttachCommand),
  ))
  .command(lazyCmd(
    {
      command: "serve",
      describe: "starts a headless opencode server",
      builder: (yargs: any) => yargs.options(networkOptions),
    },
    () => import("./cli/cmd/serve").then((m) => m.ServeCommand),
  ))
  .command(lazyCmd(
    {
      command: "web",
      describe: "start opencode server and open web interface",
      builder: (yargs: any) => yargs.options(networkOptions),
    },
    () => import("./cli/cmd/web").then((m) => m.WebCommand),
  ))
  .command(lazyCmd(
    {
      command: "acp",
      describe: "start ACP (Agent Client Protocol) server",
      builder: (yargs: any) =>
        yargs.options(networkOptions).option("cwd", { type: "string", describe: "working directory", default: process.cwd() }),
    },
    () => import("./cli/cmd/acp").then((m) => m.AcpCommand),
  ))

  // ── Parent commands with subcommands — load full module when matched ──
  .command(lazyCmd(
    { command: "mcp", describe: "manage MCP (Model Context Protocol) servers" },
    () => import("./cli/cmd/mcp").then((m) => m.McpCommand),
  ))
  .command(lazyCmd(
    { command: "console", describe: false as any },
    () => import("./cli/cmd/account").then((m) => m.ConsoleCommand),
  ))
  .command(lazyCmd(
    { command: "providers", describe: "manage AI providers and credentials" },
    () => import("./cli/cmd/providers").then((m) => m.ProvidersCommand),
  ))
  .command(lazyCmd(
    { command: "agent", describe: "manage agents" },
    () => import("./cli/cmd/agent").then((m) => m.AgentCommand),
  ))
  .command(lazyCmd(
    { command: "debug", describe: "debugging and troubleshooting tools" },
    () => import("./cli/cmd/debug").then((m) => m.DebugCommand),
  ))
  .command(lazyCmd(
    { command: "github", describe: "manage GitHub agent" },
    () => import("./cli/cmd/github").then((m) => m.GithubCommand),
  ))
  .command(lazyCmd(
    { command: "session", describe: "manage sessions" },
    () => import("./cli/cmd/session").then((m) => m.SessionCommand),
  ))
  .command(lazyCmd(
    { command: "db", describe: "database tools" },
    () => import("./cli/cmd/db").then((m) => m.DbCommand),
  ))

  // ── Lightweight commands — still lazy for consistency ──
  .command(lazyCmd(
    { command: "generate", describe: false as any },
    () => import("./cli/cmd/generate").then((m) => m.GenerateCommand),
  ))
  .command(lazyCmd(
    {
      command: "upgrade [target]",
      describe: "upgrade opencode to the latest or a specific version",
      builder: (yargs: any) =>
        yargs
          .positional("target", { describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'", type: "string" })
          .option("method", { alias: "m", describe: "installation method to use", type: "string", choices: ["curl", "npm", "pnpm", "bun", "brew", "choco", "scoop"] }),
    },
    () => import("./cli/cmd/upgrade").then((m) => m.UpgradeCommand),
  ))
  .command(lazyCmd(
    {
      command: "uninstall",
      describe: "uninstall opencode and remove all related files",
      builder: (yargs: any) =>
        yargs
          .option("keep-config", { alias: "c", describe: "keep configuration files", type: "boolean", default: false })
          .option("keep-data", { alias: "d", describe: "keep session data and snapshots", type: "boolean", default: false })
          .option("dry-run", { describe: "show what would be removed", type: "boolean", default: false })
          .option("force", { alias: "f", describe: "skip confirmation prompts", type: "boolean", default: false }),
    },
    () => import("./cli/cmd/uninstall").then((m) => m.UninstallCommand),
  ))
  .command(lazyCmd(
    {
      command: "models [provider]",
      describe: "list all available models",
      builder: (yargs: any) =>
        yargs
          .positional("provider", { describe: "provider ID to filter models by", type: "string", array: false })
          .option("verbose", { describe: "use more verbose model output (includes metadata like costs)", type: "boolean" })
          .option("refresh", { describe: "refresh the models cache from models.dev", type: "boolean" }),
    },
    () => import("./cli/cmd/models").then((m) => m.ModelsCommand),
  ))
  .command(lazyCmd(
    {
      command: "stats",
      describe: "show token usage and cost statistics",
      builder: (yargs: any) =>
        yargs
          .option("days", { describe: "show stats for the last N days", type: "number" })
          .option("tools", { describe: "number of tools to show", type: "number" })
          .option("models", { describe: "show model statistics", type: "boolean" })
          .option("project", { describe: "filter by project", type: "string" }),
    },
    () => import("./cli/cmd/stats").then((m) => m.StatsCommand),
  ))
  .command(lazyCmd(
    {
      command: "export [sessionID]",
      describe: "export session data as JSON",
      builder: (yargs: any) =>
        yargs
          .positional("sessionID", { describe: "session id to export", type: "string" })
          .option("sanitize", { describe: "redact sensitive transcript and file data", type: "boolean" }),
    },
    () => import("./cli/cmd/export").then((m) => m.ExportCommand),
  ))
  .command(lazyCmd(
    {
      command: "import <file>",
      describe: "import session data from JSON file or URL",
      builder: (yargs: any) =>
        yargs.positional("file", { describe: "path to JSON file or share URL", type: "string", demandOption: true }),
    },
    () => import("./cli/cmd/import").then((m) => m.ImportCommand),
  ))
  .command(lazyCmd(
    {
      command: "pr <number>",
      describe: "fetch and checkout a GitHub PR branch, then run opencode",
      builder: (yargs: any) =>
        yargs.positional("number", { describe: "PR number to checkout", type: "number", demandOption: true }),
    },
    () => import("./cli/cmd/pr").then((m) => m.PrCommand),
  ))
  .command(lazyCmd(
    {
      command: "plugin <module>",
      describe: "install plugin and update config",
      builder: (yargs: any) =>
        yargs
          .positional("module", { describe: "npm module name", type: "string" })
          .option("global", { alias: ["g"], describe: "install in global config", type: "boolean", default: false })
          .option("force", { alias: ["f"], describe: "replace existing plugin version", type: "boolean", default: false }),
    },
    () => import("./cli/cmd/plug").then((m) => m.PluginCommand),
  ))
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
