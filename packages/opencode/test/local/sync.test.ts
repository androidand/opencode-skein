import { describe, expect, test } from "bun:test"
import { reconcileProviders, type DiscoveredService } from "../../src/local/sync"

const auto = (baseURL: string, name = "auto") => ({
  npm: "@ai-sdk/openai-compatible",
  name,
  options: { baseURL, apiKey: "skein" },
  discoverModels: true,
})

const manual = (baseURL: string, apiKey = "korv") => ({
  npm: "@ai-sdk/openai-compatible",
  name: "hand written",
  options: { baseURL, apiKey },
})

const mdns = (name: string, host: string, port = 8080): DiscoveredService => ({
  name,
  host,
  baseURL: `http://${host}:${port}/v1`,
  source: "mdns",
})

const run = (
  providers: Parameters<typeof reconcileProviders>[0]["providers"],
  online: DiscoveredService[],
  opts?: { selfIPs?: string[]; selfSlug?: string },
) =>
  reconcileProviders({
    providers,
    online,
    selfIPs: new Set(opts?.selfIPs ?? []),
    selfSlug: opts?.selfSlug ?? "m5",
  })

describe("reconcileProviders", () => {
  test("adds a newly discovered mDNS provider", () => {
    const { providers, changes } = run({}, [mdns("rocky", "192.0.2.10")])
    expect(providers.rocky).toMatchObject({ options: { baseURL: "http://192.0.2.10:8080/v1", apiKey: "skein" } })
    expect(changes).toContainEqual({
      type: "added",
      slug: "rocky",
      baseURL: "http://192.0.2.10:8080/v1",
      source: "mdns",
    })
  })

  test("updates an auto-discovered provider whose IP moved", () => {
    const { providers, changes } = run({ rocky: auto("http://192.168.1.99:8080/v1") }, [mdns("rocky", "192.0.2.10")])
    expect((providers.rocky as any).options.baseURL).toBe("http://192.0.2.10:8080/v1")
    expect(changes).toContainEqual({
      type: "updated",
      slug: "rocky",
      from: "http://192.168.1.99:8080/v1",
      to: "http://192.0.2.10:8080/v1",
    })
  })

  test("preserves other fields of an auto-discovered entry when re-pointing it", () => {
    const existing = { ...auto("http://192.168.1.99:8080/v1"), name: "Rocky", discoverModels: true }
    const { providers } = run({ rocky: existing }, [mdns("rocky", "192.0.2.10")])
    expect(providers.rocky).toMatchObject({ name: "Rocky", discoverModels: true, options: { apiKey: "skein" } })
  })

  test("never re-points a hand-written provider that happens to share a slug", () => {
    // The module's stated contract: only entries this sync created (apiKey
    // "skein") may be auto-corrected. Re-pointing a hand-configured baseURL
    // silently sends the user's traffic to a different machine.
    const { providers, changes } = run({ m3: manual("http://192.0.2.15:11435/v1") }, [mdns("m3", "192.168.1.5")])
    expect((providers.m3 as any).options.baseURL).toBe("http://192.0.2.15:11435/v1")
    expect(changes).toContainEqual({ type: "kept-manual", slug: "m3", baseURL: "http://192.0.2.15:11435/v1" })
  })

  test("leaving a hand-written provider alone is not a config mutation", () => {
    const { changes } = run({ m3: manual("http://192.0.2.15:11435/v1") }, [mdns("m3", "192.168.1.5")])
    expect(changes.every((change) => change.type === "kept-manual")).toBe(true)
  })

  test("an already-correct entry produces no changes at all", () => {
    const { changes } = run({ rocky: auto("http://192.0.2.10:8080/v1") }, [mdns("rocky", "192.0.2.10")])
    expect(changes).toEqual([])
  })

  test("removes an auto-discovered entry pointing at one of this host's own IPs", () => {
    const { providers, changes } = run({ m3: auto("http://192.168.1.218:8080/v1") }, [], {
      selfIPs: ["192.168.1.218"],
    })
    expect(providers.m3).toBeUndefined()
    expect(changes).toContainEqual({ type: "removed-own-ip", id: "m3", host: "192.168.1.218" })
  })

  test("never removes a hand-written entry pointing at an own IP", () => {
    const { providers, changes } = run({ m3: manual("http://192.168.1.218:8080/v1") }, [], {
      selfIPs: ["192.168.1.218"],
    })
    expect(providers.m3).toBeDefined()
    expect(changes).toEqual([])
  })

  test("keeps an own-IP entry that is this machine's own slug", () => {
    const { providers } = run({ m5: auto("http://192.168.1.218:8080/v1") }, [], {
      selfIPs: ["192.168.1.218"],
      selfSlug: "m5",
    })
    expect(providers.m5).toBeDefined()
  })

  test("keeps loopback entries regardless of own IPs", () => {
    const { providers } = run({ lemonade: auto("http://localhost:13305/v1"), loop: auto("http://127.0.0.1:99/v1") }, [], {
      selfIPs: ["127.0.0.1", "localhost"],
    })
    expect(providers.lemonade).toBeDefined()
    expect(providers.loop).toBeDefined()
  })

  test("removes a stale auto-discovered duplicate squatting the same URL", () => {
    const { providers, changes } = run({ mac: auto("http://192.0.2.10:8080/v1") }, [mdns("m5", "192.0.2.10")])
    expect(providers.mac).toBeUndefined()
    expect(providers.m5).toBeDefined()
    expect(changes).toContainEqual({
      type: "removed-duplicate",
      id: "mac",
      kept: "m5",
      baseURL: "http://192.0.2.10:8080/v1",
    })
  })

  test("never removes a hand-written entry squatting the same URL", () => {
    const { providers } = run({ mac: manual("http://192.0.2.10:8080/v1") }, [mdns("m5", "192.0.2.10")])
    expect(providers.mac).toBeDefined()
    expect(providers.m5).toBeDefined()
  })

  test("a weak LAN name may add a brand-new entry", () => {
    const { providers } = run({}, [{ ...mdns("newbox", "192.168.1.30"), source: "lan" }])
    expect(providers.newbox).toBeDefined()
  })

  test("a weak LAN name never re-points an existing entry", () => {
    const { providers, changes } = run({ rocky: auto("http://192.168.1.99:8080/v1") }, [
      { ...mdns("rocky", "192.168.1.30"), source: "lan" },
    ])
    expect((providers.rocky as any).options.baseURL).toBe("http://192.168.1.99:8080/v1")
    expect(changes).toEqual([])
  })

  test("a weak LAN name never claims a URL another entry already owns", () => {
    const { providers, changes } = run({ rocky: auto("http://192.168.1.30:8080/v1") }, [
      { ...mdns("othername", "192.168.1.30"), source: "lan" },
    ])
    expect(providers.othername).toBeUndefined()
    expect(changes).toEqual([])
  })

  test("services on one of this machine's own IPs are skipped entirely", () => {
    const { providers, changes } = run({}, [mdns("m5", "192.168.1.218")], { selfIPs: ["192.168.1.218"] })
    expect(providers).toEqual({})
    expect(changes).toEqual([])
  })

  test("does not mutate the caller's provider map", () => {
    const original = { rocky: auto("http://192.168.1.99:8080/v1") }
    const snapshot = JSON.stringify(original)
    run(original, [mdns("rocky", "192.0.2.10")])
    expect(JSON.stringify(original)).toBe(snapshot)
  })

  test("canonicalises an advertised llamaswap name down to the machine slug", () => {
    const { providers } = run({}, [mdns("m5-llamaswap.local", "192.0.2.14")])
    expect(providers.m5).toBeDefined()
  })
})
