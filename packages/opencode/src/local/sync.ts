import os from "os"
import { Config } from "@/config/config"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { withGlobalConfigLock } from "./config-lock"
import { getIgnored } from "./ignored"
import { scanLlamaSwap } from "./mdns"

function normalizeBaseURL(url: string) {
  return url.replace(/\/+$/, "").toLowerCase()
}

function providerIDFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function ownIPs(): Set<string> {
  const ips = new Set<string>()
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      ips.add(iface.address)
    }
  }
  return ips
}

function canonicalName(name: string) {
  return name
    .replace(/\.local\.?$/i, "")
    .replace(/\.localdomain\.?$/i, "")
    .replace(/-llama-?swap$/i, "")
    .trim()
}

type ProviderEntry = {
  npm?: string
  name?: string
  options?: { baseURL?: string; apiKey?: string }
}

// Entries this sync created carry apiKey "skein"; only those may be
// auto-corrected or removed. Hand-written providers are never touched.
function isAutoDiscovered(p: unknown): boolean {
  const entry = p as ProviderEntry
  return entry?.npm === "@ai-sdk/openai-compatible" && entry?.options?.apiKey === "skein"
}

function baseURLHost(baseURL: string | undefined): string {
  if (!baseURL) return ""
  try {
    return new URL(baseURL).hostname
  } catch {
    return ""
  }
}

export interface DiscoveredService {
  name: string
  host: string
  baseURL: string
  source: "mdns" | "localhost" | "lan"
}

/** `kept-manual` records a decision NOT to touch anything — it is the one change type that does not mean the config was mutated. */
export type ReconcileChange =
  | { type: "removed-own-ip"; id: string; host: string }
  | { type: "added"; slug: string; baseURL: string; source: string }
  | { type: "updated"; slug: string; from: string; to: string }
  | { type: "kept-manual"; slug: string; baseURL: string }
  | { type: "removed-duplicate"; id: string; kept: string; baseURL: string }

/**
 * The whole add/update/remove decision, as a pure function over a config
 * snapshot and a scan result. Extracted from the IO so it can be tested: this
 * is the code that rewrites and DELETES entries in the user's global config,
 * and a wrong decision here silently destroys a working provider.
 */
type ProviderMap = NonNullable<Config.Info["provider"]>

export function reconcileProviders(input: {
  providers: ProviderMap
  online: readonly DiscoveredService[]
  selfIPs: ReadonlySet<string>
  selfSlug: string
}): { providers: ProviderMap; changes: ReconcileChange[] } {
  const providers = { ...input.providers }
  const changes: ReconcileChange[] = []

  // Prune auto-discovered entries that point at one of this machine's own LAN
  // IPs under a different machine's name (e.g. "gpuhost5" left pointing at an
  // address DHCP later reassigned to this host). Such an entry is definitively
  // wrong — it dispatches another machine's traffic to us — and it can never
  // be healed by the loop below because own IPs are skipped there. Loopback
  // entries (an intentional local provider) are kept.
  for (const [id, p] of Object.entries(providers)) {
    if (!isAutoDiscovered(p)) continue
    const host = baseURLHost((p as ProviderEntry).options?.baseURL)
    if (!host || host === "localhost" || host.startsWith("127.")) continue
    if (input.selfIPs.has(host) && id !== input.selfSlug) {
      delete providers[id]
      changes.push({ type: "removed-own-ip", id, host })
    }
  }

  for (const svc of input.online) {
    // Skip own IPs — this machine's own llama-swap is configured via
    // localhost, not via a LAN address that DHCP may reassign.
    if (input.selfIPs.has(svc.host)) continue

    const norm = normalizeBaseURL(svc.baseURL)
    const name = canonicalName(svc.name)
    const slug = providerIDFromName(name || svc.name)
    const urlOwner = Object.entries(providers).find(
      ([, p]) => normalizeBaseURL(String((p as ProviderEntry).options?.baseURL ?? "")) === norm,
    )?.[0]

    // Already configured correctly at this exact URL — nothing to do.
    if (urlOwner === slug) continue

    if (svc.source === "lan") {
      // Reverse-DNS identity: only add when neither this URL nor this name is
      // known. Never rename or re-point existing entries on a weak name.
      if (urlOwner || slug in providers) continue
      providers[slug] = {
        npm: "@ai-sdk/openai-compatible",
        name,
        options: { baseURL: svc.baseURL, apiKey: "skein" },
        discoverModels: true,
      }
      changes.push({ type: "added", slug, baseURL: svc.baseURL, source: svc.source })
      continue
    }

    // mDNS identity is authoritative for slug → URL.
    if (slug in providers) {
      const existing = providers[slug] as ProviderEntry
      // Only entries this sync created may be auto-corrected. A hand-written
      // provider that happens to share a slug with an advertised machine keeps
      // the baseURL the user gave it — silently re-pointing it at whatever
      // mDNS answered would hand their traffic to a different host.
      if (!isAutoDiscovered(existing)) {
        changes.push({ type: "kept-manual", slug, baseURL: existing.options?.baseURL ?? "" })
        continue
      }
      // Provider exists but IP has changed — update baseURL in place.
      const oldURL = existing.options?.baseURL ?? ""
      providers[slug] = { ...(existing as object), options: { ...(existing.options ?? {}), baseURL: svc.baseURL } }
      changes.push({ type: "updated", slug, from: oldURL, to: svc.baseURL })
    } else {
      providers[slug] = {
        npm: "@ai-sdk/openai-compatible",
        name,
        options: { baseURL: svc.baseURL, apiKey: "skein" },
        discoverModels: true,
      }
      changes.push({ type: "added", slug, baseURL: svc.baseURL, source: svc.source })
    }

    // A different auto-discovered entry occupying this machine's URL is a
    // stale duplicate (e.g. "mac" → the IP that mDNS just proved belongs to
    // "gpuhost5"). Remove it so it stops shadowing the canonical entry.
    if (urlOwner && urlOwner !== slug && isAutoDiscovered(providers[urlOwner])) {
      delete providers[urlOwner]
      changes.push({ type: "removed-duplicate", id: urlOwner, kept: slug, baseURL: svc.baseURL })
    }
  }

  return { providers, changes }
}

// syncLocalProviders scans for local llama-swap providers via mDNS + LAN probe
// and upserts them into the global opencode config.
//
// Existing providers whose baseURL has changed (stale IP) are updated in place
// by matching on the derived slug — mDNS identity (the machine's own TXT
// advertisement) is authoritative for which name maps to which address.
// Reverse-DNS names from the LAN fallback are weak (routers serve stale DHCP
// lease names) and may only add brand-new entries, never modify existing ones.
// Providers not found in the scan are left untouched — they may be offline.
const syncLocalProviders = Effect.gen(function* () {
  // Tests (and any embedder that wants a hermetic provider set) must be able
  // to opt out: the scan probes the real LAN and writes whatever fleet it
  // finds into the global config, which then becomes eligible for default
  // model resolution — a unit test silently prompting a real machine.
  if (process.env["OPENCODE_DISABLE_LOCAL_SYNC"]) {
    yield* Effect.logInfo("local provider sync disabled via OPENCODE_DISABLE_LOCAL_SYNC")
    return
  }
  const configSvc = yield* Config.Service
  const discovered = yield* Effect.promise(() => scanLlamaSwap(1000, false))
  const ignored = yield* Effect.promise(() => getIgnored())
  const online = discovered.filter((svc) => svc.online && !ignored.has(normalizeBaseURL(svc.baseURL)))

  if (online.length === 0) {
    yield* Effect.logInfo("no local providers found")
    return
  }

  yield* Effect.logInfo("found local providers", { count: online.length, names: online.map((s) => s.name) })

  // The read-modify-write below runs under the global config lock — the scan
  // above is lock-free (slow, network), but the config must be read and
  // written back atomically w.r.t. /connect and /disconnect.
  yield* withGlobalConfigLock(
    Effect.gen(function* () {
      const global = yield* configSvc.getGlobal()
      const { providers, changes } = reconcileProviders({
        providers: { ...(global.provider ?? {}) },
        online,
        selfIPs: ownIPs(),
        selfSlug: providerIDFromName(canonicalName(os.hostname())),
      })

      for (const change of changes) {
        switch (change.type) {
          case "removed-own-ip":
            yield* Effect.logInfo("removed stale provider pointing at own IP", { id: change.id, host: change.host })
            break
          case "added":
            yield* Effect.logInfo("added provider", {
              slug: change.slug,
              baseURL: change.baseURL,
              source: change.source,
            })
            break
          case "updated":
            yield* Effect.logInfo("updated provider baseURL", { slug: change.slug, old: change.from, new: change.to })
            break
          case "kept-manual":
            yield* Effect.logInfo("left hand-written provider untouched", {
              slug: change.slug,
              baseURL: change.baseURL,
            })
            break
          case "removed-duplicate":
            yield* Effect.logInfo("removed duplicate provider for same baseURL", {
              id: change.id,
              kept: change.kept,
              baseURL: change.baseURL,
            })
            break
        }
      }

      // `kept-manual` is a decision not to touch anything, so it must not
      // trigger a write.
      const changed = changes.some((change) => change.type !== "kept-manual")

      if (changed) yield* configSvc.updateGlobal({ ...global, provider: providers }, { replace: ["provider"] })
    }),
  )
})

// Run synchronously so Provider (which reads cfg.provider) gets the discovered
// entries. The 1–2 s mDNS + LAN scan is bounded and only runs once at startup.
export const layer = Layer.effectDiscard(
  syncLocalProviders.pipe(Effect.catch((err) => Effect.logError("sync failed", { error: String(err) }))),
)

export const node = LayerNode.make({
  name: "@opencode/LocalProviderSync",
  layer,
  deps: [Config.node],
})

export * as LocalProviderSync from "./sync"
