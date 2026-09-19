// A session registers the moment it is created, when its title is still a
// placeholder ("New session - <timestamp>"); the real title is generated after
// the first turn. Without a rename path every peer on the machine sees the
// placeholder forever and cannot address the session by name.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { startSidecar, type RunningSidecar } from "../../../src/peer/claude/sidecar-server"

describe("sidecar registration name", () => {
  let configDir: string
  let socketDir: string
  let previousConfigDir: string | undefined
  let sidecar: RunningSidecar | undefined

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "sidecar-name-test-"))
    socketDir = await mkdtemp(join(tmpdir(), "sidecar-name-sock-"))
    await mkdir(join(configDir, "sessions"), { recursive: true })
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    await sidecar?.stop()
    sidecar = undefined
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    await Promise.all([
      rm(configDir, { recursive: true, force: true }),
      rm(socketDir, { recursive: true, force: true }),
    ])
  })

  async function registeredName(pid: number): Promise<string> {
    const raw = await readFile(join(configDir, "sessions", `${pid}.json`), "utf8")
    return JSON.parse(raw).name
  }

  test("setName rewrites the registration other processes read", async () => {
    sidecar = await startSidecar({
      ownerSessionID: "ses_name_test",
      cwd: "/repo",
      name: "New session - 2026-09-18T17:02:31.639Z",
      socketDir,
      onMessage: () => undefined,
    })
    expect(await registeredName(sidecar.pid)).toBe("opencode:New session - 2026-09-18T17:02:31.639Z")

    await sidecar.setName("Team check-in message")
    expect(await registeredName(sidecar.pid)).toBe("opencode:Team check-in message")
  })

  test("a rename after shutdown does not resurrect the registration", async () => {
    const running = await startSidecar({
      ownerSessionID: "ses_name_test_2",
      cwd: "/repo",
      name: "first",
      socketDir,
      onMessage: () => undefined,
    })
    const { pid } = running
    await running.stop()
    await running.setName("second")
    await expect(readFile(join(configDir, "sessions", `${pid}.json`), "utf8")).rejects.toThrow()
  })
})
