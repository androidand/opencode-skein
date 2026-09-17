// Read (never write) a Claude Code session's registry entry and key file.
// Same-OS-user file permissions are the entire security boundary here — see
// openspec/changes/claude-peer-protocol-spike/findings.md, "Auth / key file".
import { createHash } from "crypto"
import { readFile } from "fs/promises"
import { homedir } from "os"
import { join } from "path"
import { Process } from "@/util/process"

export interface ClaudeRegistryEntry {
  pid: number
  sessionId: string
  cwd: string
  name?: string
  status?: string
  peerProtocol?: number
  messagingSocketPath: string
  procStart?: string
}

export interface ClaudeKeyFile {
  peerToken: string
  procStart: string
  pidDomain: string
}

export function registryDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
}

export function sessionsDir(): string {
  return join(registryDir(), "sessions")
}

/** `sha256(messagingSocketPath)`, lowercase hex, no salt — confirmed exactly in findings.md. */
export function keyFileHash(socketPath: string): string {
  return createHash("sha256").update(socketPath).digest("hex")
}

function isRegistryEntry(value: unknown): value is ClaudeRegistryEntry {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.pid === "number" && typeof v.sessionId === "string" && typeof v.messagingSocketPath === "string"
}

function isKeyFile(value: unknown): value is ClaudeKeyFile {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.peerToken === "string"
}

export async function readRegistryEntry(pid: number): Promise<ClaudeRegistryEntry | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(registryDir(), "sessions", `${pid}.json`), "utf8"))
    return isRegistryEntry(raw) ? raw : undefined
  } catch {
    return undefined
  }
}

/** The only place this module reads a `*.key` file — never from the presence source. */
export async function readKeyFile(entry: ClaudeRegistryEntry): Promise<ClaudeKeyFile | undefined> {
  const hash = keyFileHash(entry.messagingSocketPath)
  try {
    const raw: unknown = JSON.parse(await readFile(join(registryDir(), "sessions", `${entry.pid}.${hash}.key`), "utf8"))
    return isKeyFile(raw) ? raw : undefined
  } catch {
    return undefined
  }
}

/**
 * The PID-reuse defense findings.md calls for: confirm the live process's
 * actual start time matches what the key file recorded, in the exact format
 * confirmed empirically (`TZ=UTC LC_ALL=C ps -o lstart=`, not local time).
 */
export async function verifyProcessIdentity(pid: number, expectedProcStart: string): Promise<boolean> {
  try {
    const out = await Process.text(["ps", "-o", "lstart=", "-p", String(pid)], {
      env: { TZ: "UTC", LC_ALL: "C" },
      nothrow: true,
    })
    if (out.code !== 0) return false
    return out.text.trim() === expectedProcStart.trim()
  } catch {
    return false
  }
}

export * as ClaudeRegistry from "./registry"
