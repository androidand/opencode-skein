import path from "path"
import { Global } from "@opencode-ai/core/global"

// fork: syncLocalProviders re-adds anything it finds on mDNS that isn't in
// config, with no way to tell "never configured" apart from "the user just
// disconnected this". Without this list, /disconnect's config write gets
// silently undone by the very next scan (including the one dispose+bootstrap
// triggers right after disconnect in the TUI dialog). Entries here are the
// user's explicit "leave this alone" list; /connect clears an entry so
// reconnecting resumes normal auto-heal (IP updates, etc).
const file = path.join(Global.Path.data, "local-ignored.json")

function normalizeBaseURL(url: string) {
  return url.replace(/\/+$/, "").toLowerCase()
}

export async function getIgnored(): Promise<Set<string>> {
  const data = await Bun.file(file)
    .json()
    .catch(() => [])
  return new Set(Array.isArray(data) ? data.map(String) : [])
}

export async function addIgnored(baseURL: string): Promise<void> {
  const ignored = await getIgnored()
  ignored.add(normalizeBaseURL(baseURL))
  await Bun.file(file).write(JSON.stringify([...ignored]))
}

export async function removeIgnored(baseURL: string): Promise<void> {
  const ignored = await getIgnored()
  if (!ignored.delete(normalizeBaseURL(baseURL))) return
  await Bun.file(file).write(JSON.stringify([...ignored]))
}

export * as LocalIgnored from "./ignored"
