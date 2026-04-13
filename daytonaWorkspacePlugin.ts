import type { Daytona, Sandbox } from "@daytonaio/sdk"
import type { Plugin } from "@opencode-ai/plugin"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { access, mkdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"

let client: Promise<Daytona> | undefined

let daytona = function daytona(): Promise<Daytona> {
  if (client == null) {
    client = import("@daytonaio/sdk").then(
      ({ Daytona }) =>
        new Daytona({
          apiKey: "dtn_2ffe19d27837953f1a46cc297d8a5331d4c46b00856eb5f4a4afded3f3426038",
        }),
    )
  }
  return client
}

const preview = new Map<string, { url: string; token: string }>()
const repo = "/home/daytona/workspace/repo"

const local = fileURLToPath(
  new URL("./packages/opencode/dist/opencode-linux-x64-baseline/bin/opencode", import.meta.url),
)
const bootstrap = fileURLToPath(new URL("./daytonaWorkspaceBootstrap.sh", import.meta.url))

async function exists(file: string) {
  return access(file)
    .then(() => true)
    .catch(() => false)
}

function sh(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

async function boot() {
  return Bun.file(bootstrap).text()
}

// Internally Daytona uses axios, which tries to overwrite stack
// traces when a failure happens. That path fails in Bun, however, so
// when something goes wrong you only see a very obscure error.
async function withSandbox<T>(name: string, fn: (sandbox: Sandbox) => Promise<T>) {
  const stack = Error.captureStackTrace
  // @ts-expect-error temporary compatibility hack for Daytona's axios stack handling in Bun
  Error.captureStackTrace = undefined
  try {
    return await fn(await (await daytona()).get(name))
  } finally {
    Error.captureStackTrace = stack
  }
}

export const DaytonaWorkspacePlugin: Plugin = async ({ experimental_workspace, worktree, project }) => {
  experimental_workspace.register("daytona", {
    name: "Daytona",
    description: "Create a remote Daytona workspace",
    configure(config) {
      return config
    },
    async create(config) {
      const temp = join(tmpdir(), `opencode-daytona-${randomUUID()}`)

      console.log("creating sandbox...")

      const sandbox = await (
        await daytona()
      ).create({
        name: config.name,
        envVars: {
          foo: "bar",
        },
      })

      const sid = `setup-${randomUUID()}`
      await sandbox.process.createSession(sid)

      try {
        console.log("creating ssh...")

        const ssh = await withSandbox(config.name, (sandbox) => sandbox.createSshAccess())
        console.log("daytona:", ssh.sshCommand)

        const run = async (command: string, opts?: { stream?: boolean }) => {
          if (!opts?.stream) {
            const result = await sandbox.process.executeCommand(command)
            if (result.exitCode === 0) return result
            throw new Error(result.result || `sandbox command failed: ${command}`)
          }

          const res = await sandbox.process.executeSessionCommand(sid, { command, runAsync: true })
          if (!res.cmdId) throw new Error(`sandbox command failed to start: ${command}`)

          let out = ""
          let err = ""
          await sandbox.process.getSessionCommandLogs(
            sid,
            res.cmdId,
            (chunk) => {
              out += chunk
              process.stdout.write(chunk)
            },
            (chunk) => {
              err += chunk
              process.stderr.write(chunk)
            },
          )

          for (let i = 0; i < 120; i++) {
            const cmd = await sandbox.process.getSessionCommand(sid, res.cmdId)
            if (typeof cmd.exitCode !== "number") {
              await Bun.sleep(500)
              continue
            }
            if (cmd.exitCode === 0) return cmd
            throw new Error(err || out || `sandbox command failed: ${command}`)
          }

          throw new Error(`sandbox command timed out waiting for exit code: ${command}`)
        }

        const dir = join(temp, "repo")
        const tar = join(temp, "repo.tgz")
        const scr = join(temp, "bootstrap.sh")
        const source = `file://${worktree}`
        await mkdir(temp, { recursive: true })
        const args = ["clone", "--depth", "1", "--no-local"]
        if (config.branch) args.push("--branch", config.branch)
        args.push(source, dir)

        console.log("git cloning...")

        const clone = Bun.spawn(["git", ...args], {
          cwd: tmpdir(),
          stdout: "pipe",
          stderr: "pipe",
        })
        const code = await clone.exited
        if (code !== 0) throw new Error(await new Response(clone.stderr).text())

        console.log("tarring...")

        const packed = Bun.spawn(["tar", "-czf", tar, "-C", temp, "repo"], {
          stdout: "ignore",
          stderr: "pipe",
        })
        if ((await packed.exited) !== 0) throw new Error(await new Response(packed.stderr).text())

        console.log("writing bootstrap script...")

        await Bun.write(scr, await boot())

        console.log("uploading files...")

        await sandbox.fs.uploadFile(tar, "repo.tgz")
        await sandbox.fs.uploadFile(scr, "bootstrap.sh")

        console.log("local", local)
        if (await exists(local)) {
          console.log("uploading local binary...")
          await sandbox.fs.uploadFile(local, "opencode")
        }

        console.log("bootstrapping workspace...")

        await run(`bash bootstrap.sh ${sh(project.id)}`, {
          stream: true,
        })
        return
      } finally {
        await sandbox.process.deleteSession(sid).catch(() => undefined)
      }
    },
    async remove(config) {
      const sandbox = await (await daytona()).get(config.name).catch(() => undefined)
      if (!sandbox) return
      await (await daytona()).delete(sandbox)
      preview.delete(config.name)
    },
    async target(config) {
      let link = preview.get(config.name)
      if (!link) {
        link = await withSandbox(config.name, (sandbox) => sandbox.getPreviewLink(3096))
        preview.set(config.name, link)
      }
      return {
        type: "remote",
        url: link.url,
        headers: {
          "x-daytona-preview-token": link.token,
          "x-daytona-skip-preview-warning": "true",
          "x-opencode-directory": repo,
        },
      }
    },
  })

  return {}
}

export default DaytonaWorkspacePlugin
