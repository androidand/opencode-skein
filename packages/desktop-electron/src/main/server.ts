import { app } from "electron"
import { Effect } from "effect"
import { DEFAULT_SERVER_URL_KEY, WSL_ENABLED_KEY } from "./constants"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"

export type WslConfig = { enabled: boolean }

export const getDefaultServerUrl = Effect.sync((): string | null => {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
})

export const setDefaultServerUrl = (url: string | null) =>
  Effect.sync(() => {
    if (url) {
      getStore().set(DEFAULT_SERVER_URL_KEY, url)
      return
    }
    getStore().delete(DEFAULT_SERVER_URL_KEY)
  })

export const getWslConfig = Effect.sync((): WslConfig => {
  const value = getStore().get(WSL_ENABLED_KEY)
  return { enabled: typeof value === "boolean" ? value : false }
})

export const setWslConfig = (config: WslConfig) =>
  Effect.sync(() => getStore().set(WSL_ENABLED_KEY, config.enabled))

export const spawnLocalServerEffect = Effect.fn("Server.spawnLocalServer")(
  function* (hostname: string, port: number, password: string) {
    yield* prepareServerEnv(password)
    const { Log, Server } = yield* Effect.promise(() =>
      import("virtual:opencode-server") as Promise<typeof import("virtual:opencode-server")>,
    )
    yield* Effect.promise(() => Log.init({ level: "WARN" }))
    const listener = yield* Effect.promise(() =>
      Server.listen({
        port,
        hostname,
        username: "opencode",
        password,
        cors: ["oc://renderer"],
      }),
    )

    const healthCheck = Effect.gen(function* () {
      const url = `http://${hostname}:${port}`
      while (true) {
        const healthy = yield* checkHealthEffect(url, password)
        if (healthy) return
        yield* Effect.sleep("100 millis")
      }
    })

    return { listener, health: healthCheck }
  },
)

const prepareServerEnv = (password: string) =>
  Effect.sync(() => {
    const shell = process.platform === "win32" ? null : getUserShell()
    const shellEnv = shell ? (loadShellEnv(shell) ?? {}) : {}
    const env = {
      ...process.env,
      ...shellEnv,
      OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
      OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
      OPENCODE_CLIENT: "desktop",
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: password,
      XDG_STATE_HOME: app.getPath("userData"),
    }
    Object.assign(process.env, env)
  })

export const checkHealthEffect = Effect.fn("Server.checkHealth")(function* (url: string, password?: string | null) {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`opencode:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = yield* Effect.promise(() =>
      fetch(healthUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(3000),
      }),
    )
    return res.ok
  } catch {
    return false
  }
})
