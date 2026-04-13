import type { MiddlewareHandler } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { getAdaptor } from "@/control-plane/adaptors"
import { WorkspaceID } from "@/control-plane/schema"
import { Workspace } from "@/control-plane/workspace"
import { ServerProxy } from "../proxy"
import { Filesystem } from "@/util/filesystem"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { AppRuntime } from "@/effect/app-runtime"
import { Log } from "@/util/log"

type Rule = { method?: string; path: string; exact?: boolean; action: "local" | "forward" }

const hop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
])

const IS_WORKSPACE = process.env.OPENCODE_WORKSPACE === "true"

const RULES: Array<Rule> = [
  { path: "/session/status", action: "forward" },
  { method: "GET", path: "/session", action: "local" },
]

function local(method: string, path: string) {
  for (const rule of RULES) {
    if (rule.method && rule.method !== method) continue
    const match = rule.exact ? path === rule.path : path === rule.path || path.startsWith(rule.path + "/")
    if (match) return rule.action === "local"
  }
  return false
}

function getSessionID(url: URL) {
  if (url.pathname === "/session/status") return null

  const id = url.pathname.match(/^\/session\/([^/]+)(?:\/|$)/)?.[1]
  if (!id) return null

  return SessionID.make(id)
}

function sh(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

async function curl(url: URL, extra: HeadersInit | undefined, req: Request) {
  const headers = new Headers(req.headers)
  for (const key of hop) headers.delete(key)
  headers.delete("accept-encoding")
  headers.delete("x-opencode-directory")
  headers.delete("x-opencode-workspace")

  if (extra) {
    for (const [key, value] of new Headers(extra).entries()) {
      headers.set(key, value)
    }
  }

  const parts = ["curl", "-X", req.method]
  for (const [key, value] of headers.entries()) {
    parts.push("-H", sh(`${key}: ${value}`))
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req
      .clone()
      .text()
      .catch(() => "")
    if (body) parts.push("--data-binary", sh(body))
  }

  parts.push(sh(url.toString()))
  return parts.join(" ")
}

async function getSessionWorkspace(url: URL) {
  const id = getSessionID(url)
  if (!id) return null

  const session = await Session.get(id).catch(() => undefined)
  return session?.workspaceID
}

export function WorkspaceRouterMiddleware(upgrade: UpgradeWebSocket): MiddlewareHandler {
  const log = Log.Default.clone().tag("service", "workspace-router")

  return async (c, next) => {
    const raw = c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
    const directory = Filesystem.resolve(
      (() => {
        try {
          return decodeURIComponent(raw)
        } catch {
          return raw
        }
      })(),
    )

    const url = new URL(c.req.url)

    const sessionWorkspaceID = await getSessionWorkspace(url)
    const workspaceID = sessionWorkspaceID || url.searchParams.get("workspace")

    // If no workspace is provided we use the project
    if (!workspaceID || url.pathname.startsWith("/console") || IS_WORKSPACE) {
      return Instance.provide({
        directory,
        init: () => AppRuntime.runPromise(InstanceBootstrap),
        async fn() {
          return next()
        },
      })
    }

    const workspace = await Workspace.get(WorkspaceID.make(workspaceID))

    if (!workspace) {
      return new Response(`Workspace not found: ${workspaceID}`, {
        status: 500,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      })
    }

    const adaptor = await getAdaptor(workspace.projectID, workspace.type)
    const target = await adaptor.target(workspace)

    log.info("workspace route resolved", {
      workspaceID,
      workspace_type: workspace.type,
      target_type: target.type,
      request: url.toString(),
    })

    if (target.type === "local") {
      return WorkspaceContext.provide({
        workspaceID: WorkspaceID.make(workspaceID),
        fn: () =>
          Instance.provide({
            directory: target.directory,
            init: () => AppRuntime.runPromise(InstanceBootstrap),
            async fn() {
              return next()
            },
          }),
      })
    }

    if (local(c.req.method, url.pathname)) {
      // No instance provided because we are serving cached data; there
      // is no instance to work with
      return next()
    }

    const proxyURL = new URL(target.url)
    proxyURL.pathname = `${proxyURL.pathname.replace(/\/$/, "")}${url.pathname}`
    proxyURL.search = url.search
    proxyURL.hash = url.hash
    proxyURL.searchParams.delete("workspace")

    log.info("workspace proxy forwarding", {
      workspaceID,
      request: url.toString(),
      target: String(target.url),
      proxy: proxyURL.toString(),
    })

    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      return ServerProxy.websocket(upgrade, proxyURL, target.headers, c.req.raw, c.env)
    }

    const headers = new Headers(c.req.raw.headers)
    headers.delete("x-opencode-workspace")

    const req = new Request(c.req.raw, { headers })
    console.log("workspace proxy curl", await curl(proxyURL, target.headers, req))

    return ServerProxy.http(proxyURL, target.headers, req)
  }
}
