#!/usr/bin/env bun

import type { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { WorkspacePaths } from "../src/server/routes/instance/httpapi/workspace"
import { FilePaths } from "../src/server/routes/instance/httpapi/file"
import { McpPaths } from "../src/server/routes/instance/httpapi/mcp"
import { Flag } from "../src/flag/flag"
import { ControlPlaneRoutes } from "../src/server/routes/control"
import { WorkspaceRoutes } from "../src/server/routes/control/workspace"
import { InstanceRoutes } from "../src/server/routes/instance"
import { UIRoutes } from "../src/server/routes/ui"

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL"

interface Route {
  surface: string
  method: Method
  path: string
  status: string
}

const methodOrder = new Map<Method, number>([
  ["GET", 0],
  ["POST", 1],
  ["PUT", 2],
  ["PATCH", 3],
  ["DELETE", 4],
  ["ALL", 5],
])

const bridged = new Set([
  key("GET", "/question"),
  key("POST", "/question/:requestID/reply"),
  key("POST", "/question/:requestID/reject"),
  key("GET", "/permission"),
  key("POST", "/permission/:requestID/reply"),
  key("GET", "/config"),
  key("GET", "/config/providers"),
  key("GET", "/provider"),
  key("GET", "/provider/auth"),
  key("POST", "/provider/:providerID/oauth/authorize"),
  key("POST", "/provider/:providerID/oauth/callback"),
  key("GET", "/project"),
  key("GET", "/project/current"),
  key("GET", FilePaths.list),
  key("GET", FilePaths.content),
  key("GET", FilePaths.status),
  key("GET", McpPaths.status),
  ...Object.values(WorkspacePaths).map((path) => key("GET", path)),
])

const topLevelNext = new Set([
  key("GET", "/path"),
  key("GET", "/vcs"),
  key("GET", "/vcs/diff"),
  key("GET", "/command"),
  key("GET", "/agent"),
  key("GET", "/skill"),
  key("GET", "/lsp"),
  key("GET", "/formatter"),
])

function key(method: string, path: string) {
  return `${method} ${path}`
}

function normalize(prefix: string, route: string) {
  if (!prefix) return route
  if (route === "/") return prefix
  return `${prefix}${route}`.replaceAll(/\/+/g, "/")
}

function routes(surface: string, app: Hono, prefix = "") {
  const seen = new Map<string, Route>()
  for (const route of app.routes as Array<{ method: Method; path: string }>) {
    if (surface !== "ui" && route.method === "ALL" && route.path === "/*") continue
    const path = normalize(prefix, route.path)
    seen.set(key(route.method, path), {
      surface,
      method: route.method,
      path,
      status: classify(route.method, path, surface),
    })
  }
  return [...seen.values()].toSorted(compare)
}

function compare(a: Route, b: Route) {
  return (
    a.surface.localeCompare(b.surface) ||
    a.path.localeCompare(b.path) ||
    (methodOrder.get(a.method) ?? 99) - (methodOrder.get(b.method) ?? 99)
  )
}

function classify(method: Method, path: string, surface: string) {
  if (bridged.has(key(method, path))) return "bridged"
  if (topLevelNext.has(key(method, path))) return "next"
  if (surface === "ui") return "special"
  if (path === "/event") return "special"
  if (path.startsWith("/pty") || path.startsWith("/tui")) return "special"
  if (path.startsWith("/session") || path.startsWith("/sync")) return "later"
  if (path.startsWith("/experimental")) return method === "GET" ? "next" : "later"
  if (path.startsWith("/mcp")) return "later"
  if (path === "/instance/dispose") return "next"
  return "later"
}

function table(items: Route[]) {
  return [
    "| Surface | Method | Path | Status |",
    "| --- | --- | --- | --- |",
    ...items.map((item) => `| ${item.surface} | \`${item.method}\` | \`${item.path}\` | \`${item.status}\` |`),
  ].join("\n")
}

Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = false

const websocket = (() => () => new Response(null, { status: 501 })) as unknown as UpgradeWebSocket
const inventory = [
  ...routes("control", ControlPlaneRoutes()),
  ...routes("workspace", WorkspaceRoutes(), "/experimental/workspace"),
  ...routes("instance", InstanceRoutes(websocket)),
  ...routes("ui", UIRoutes()),
].toSorted(compare)

await Bun.write(
  new URL("../specs/effect/http-route-inventory.md", import.meta.url),
  `# Http Route Inventory

Generated from Hono route registrations by \`packages/opencode/script/http-route-inventory.ts\`.

Status meanings are defined in \`specs/effect/http-api.md\`.

${table(inventory)}
`,
)
