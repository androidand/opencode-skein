import { Global } from "@/global"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect, Option, Schema } from "effect"
import path from "path"

export const SERVICE_DIR = path.join(Global.Path.data, "service")
export const CONFIG_FILE = path.join(SERVICE_DIR, "config.json")
export const UNIX_LAUNCHER = path.join(SERVICE_DIR, "run.sh")
export const WINDOWS_LAUNCHER = path.join(SERVICE_DIR, "run.ps1")
export const stdoutLogFile = path.join(Global.Path.log, "service.stdout.log")
export const stderrLogFile = path.join(Global.Path.log, "service.stderr.log")

export const StoredConfig = Schema.Struct({
  password: Schema.String,
  hostname: Schema.String,
})

export type StoredConfig = Schema.Schema.Type<typeof StoredConfig>

export interface InstallInput {
  readonly password?: string
  readonly hostname?: string
}

export interface InstallResult {
  readonly password: string
  readonly hostname: string
  readonly platform: NodeJS.Platform
  readonly target: string
}

export interface PlatformInstallInput {
  readonly password: string
  readonly hostname: string
  readonly command: string[]
}

export interface PlatformInstallResult {
  readonly target: string
}

export class ServiceError extends Schema.TaggedErrorClass<ServiceError>()("ServiceError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export const fail = (message: string) => (cause: unknown) => new ServiceError({ message, cause })

export function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_"
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => alphabet[byte % alphabet.length]).join("")
}

export function quoteShell(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function quotePowerShell(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

export function quoteSystemd(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

export function quoteWindowsArg(value: string) {
  if (!value) return '""'
  if (!/[\s"]/u.test(value)) return value
  let result = '"'
  let slashes = 0
  for (const char of value) {
    if (char === "\\") {
      slashes += 1
      continue
    }
    if (char === '"') {
      result += "\\".repeat(slashes * 2 + 1) + char
      slashes = 0
      continue
    }
    result += "\\".repeat(slashes) + char
    slashes = 0
  }
  return result + "\\".repeat(slashes * 2) + '"'
}

export function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function usesScriptRuntime() {
  const basename = path.basename(process.execPath).toLowerCase()
  return basename === "node" || basename === "node.exe" || basename === "bun" || basename === "bun.exe"
}

export function resolveServeCommand(fs: AppFileSystem.Interface, hostname: string) {
  return Effect.gen(function* () {
    if (usesScriptRuntime() && process.argv[1] && (yield* fs.existsSafe(process.argv[1]).pipe(Effect.orElseSucceed(() => false)))) {
      return [process.execPath, ...process.execArgv, process.argv[1], "serve", "--hostname", hostname]
    }
    return [process.execPath, "serve", "--hostname", hostname]
  })
}

export function buildUnixLauncher(command: string[], password: string) {
  return [
    "#!/bin/sh",
    "set -eu",
    `export OPENCODE_SERVER_PASSWORD=${quoteShell(password)}`,
    `exec ${command.map(quoteShell).join(" ")}`,
    "",
  ].join("\n")
}

export function buildWindowsLauncher(command: string[], password: string) {
  const args = command.slice(1).map(quotePowerShell).join(", ")
  return [
    "$ErrorActionPreference = 'Stop'",
    `[Environment]::SetEnvironmentVariable('OPENCODE_SERVER_PASSWORD', ${quotePowerShell(password)}, 'Process')`,
    `$arguments = @(${args})`,
    `& ${quotePowerShell(command[0])} @arguments`,
    "exit $LASTEXITCODE",
    "",
  ].join("\r\n")
}

export function readStoredConfig(fs: AppFileSystem.Interface) {
  const decodeStored = Schema.decodeUnknownOption(StoredConfig)
  return Effect.gen(function* () {
    const exists = yield* fs.existsSafe(CONFIG_FILE).pipe(Effect.mapError(fail(`Failed to access ${CONFIG_FILE}`)))
    if (!exists) return undefined
    const raw = yield* fs.readJson(CONFIG_FILE).pipe(Effect.mapError(fail(`Failed to read ${CONFIG_FILE}`)))
    return Option.getOrUndefined(decodeStored(raw))
  })
}

export function writeTextFile(fs: AppFileSystem.Interface, file: string, content: string, mode?: number) {
  return fs.writeWithDirs(file, content, mode).pipe(Effect.mapError(fail(`Failed to write ${file}`)))
}

export function writeJsonFile(fs: AppFileSystem.Interface, file: string, content: unknown, mode?: number) {
  return fs.writeWithDirs(file, JSON.stringify(content, null, 2), mode).pipe(Effect.mapError(fail(`Failed to write ${file}`)))
}

export function chmodFile(fs: AppFileSystem.Interface, file: string, mode: number) {
  if (process.platform === "win32") return Effect.void
  return fs.chmod(file, mode).pipe(Effect.mapError(fail(`Failed to update permissions for ${file}`)))
}
