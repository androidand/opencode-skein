import { describe, expect, test } from "bun:test"
import { pick } from "../../src/local/placement"
import type { Info as ProviderInfo } from "../../src/provider/provider"

// A minimal live host: answers /api/hardware and /api/fit. `loaded` marks the
// host as having the model resident.
function mockHost(id: string, opts: { loaded?: string }): ProviderInfo {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/api/hardware") {
        return Response.json({
          gpus: [],
          inference: { busy: false, in_flight: 0, slots_total: 1 },
          loaded_model: opts.loaded ? { id: opts.loaded } : undefined,
        })
      }
      if (url.pathname === "/api/fit") {
        return Response.json({
          models: [
            {
              model: "big",
              fit_level: "perfect",
              max_safe_ctx: 32_768,
              est_tokens_per_sec: 300,
              backend: "llamacpp",
              vram_free_mb: 20_000,
            },
          ],
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    id,
    options: { baseURL: `http://127.0.0.1:${server.port}/v1` },
    models: Object.fromEntries(["big"].map((m) => [m, { id: m, capabilities: { toolcall: true } }])),
  } as unknown as ProviderInfo
}

describe("pick() ownership scoring (task 2.1)", () => {
  test("an unowned host ranks above an owned host with a different model", async () => {
    const unowned = mockHost("unowned", { loaded: "big" })
    const owned = mockHost("owned", { loaded: "big" })
    const parent = mockHost("parent", {})
    const providers = { parent, unowned, owned } as unknown as Record<string, ProviderInfo>
    const result = await pick({
      parent: { providerID: "parent" as never, modelID: "big" as never },
      providers,
      promptText: "x".repeat(4_000),
      ownership: [{ providerID: "owned", modelID: "small" }],
    })
    expect(result.kind).toBe("placed")
    if (result.kind !== "placed") return
    expect(result.placement.providerID as string).toBe("unowned")
    const ownedEntry = result.candidates.find((c) => (c.providerID as string) === "owned")
    expect(ownedEntry?.ownership).toBe("owned-different-model")
    const unownedEntry = result.candidates.find((c) => (c.providerID as string) === "unowned")
    expect(unownedEntry?.ownership).toBe("unowned")
    expect(unownedEntry!.score!).toBeGreaterThan(ownedEntry!.score!)
    result.release()
  })

  test("an unowned host ranks above an owned host with the same model", async () => {
    const unowned = mockHost("unowned", { loaded: "big" })
    const owned = mockHost("owned", { loaded: "big" })
    const parent = mockHost("parent", {})
    const providers = { parent, unowned, owned } as unknown as Record<string, ProviderInfo>
    const result = await pick({
      parent: { providerID: "parent" as never, modelID: "big" as never },
      providers,
      promptText: "x".repeat(4_000),
      ownership: [{ providerID: "owned", modelID: "big" }],
    })
    expect(result.kind).toBe("placed")
    if (result.kind !== "placed") return
    expect(result.placement.providerID as string).toBe("unowned")
    const ownedEntry = result.candidates.find((c) => (c.providerID as string) === "owned")
    expect(ownedEntry?.ownership).toBe("owned-same-model")
    const unownedEntry = result.candidates.find((c) => (c.providerID as string) === "unowned")
    expect(unownedEntry?.ownership).toBe("unowned")
    expect(unownedEntry!.score!).toBeGreaterThan(ownedEntry!.score!)
    result.release()
  })
})

describe("pick() fixture fleet ranking (task 2.3)", () => {
  // design.md rank order:
  //   1. unowned host, model resident     (best)
  //   2. unowned host, model needs load
  //   3. owned host, bound session same model
  //   4. owned host, bound session different model  (worst — forces swap)
  //   5. unknown (probe failed)           (below anything visible)

  test("unowned resident beats unowned cold-load", async () => {
    const resident = mockHost("resident", { loaded: "big" })
    const cold = mockHost("cold", {})
    const parent = mockHost("parent", {})
    const providers = { parent, resident, cold } as unknown as Record<string, ProviderInfo>
    const result = await pick({
      parent: { providerID: "parent" as never, modelID: "big" as never },
      providers,
      promptText: "x".repeat(4_000),
    })
    expect(result.kind).toBe("placed")
    if (result.kind !== "placed") return
    expect(result.placement.providerID as string).toBe("resident")
    result.release()
  })

  test("owned-same-model beats owned-different-model (swap-forcing is last)", async () => {
    const same = mockHost("same", { loaded: "big" })
    const diff = mockHost("diff", { loaded: "big" })
    const parent = mockHost("parent", {})
    const providers = { parent, same, diff } as unknown as Record<string, ProviderInfo>
    const result = await pick({
      parent: { providerID: "parent" as never, modelID: "big" as never },
      providers,
      promptText: "x".repeat(4_000),
      ownership: [
        { providerID: "same", modelID: "big" },
        { providerID: "diff", modelID: "small" },
      ],
    })
    expect(result.kind).toBe("placed")
    if (result.kind !== "placed") return
    expect(result.placement.providerID as string).toBe("same")
    const sameEntry = result.candidates.find((c) => (c.providerID as string) === "same")
    const diffEntry = result.candidates.find((c) => (c.providerID as string) === "diff")
    expect(sameEntry?.ownership).toBe("owned-same-model")
    expect(diffEntry?.ownership).toBe("owned-different-model")
    expect(sameEntry!.score!).toBeGreaterThan(diffEntry!.score!)
    result.release()
  })

  test("unowned host beats owned-different-model even when owned is resident", async () => {
    const unowned = mockHost("unowned", { loaded: "big" })
    const owned = mockHost("owned", { loaded: "big" })
    const parent = mockHost("parent", {})
    const providers = { parent, unowned, owned } as unknown as Record<string, ProviderInfo>
    const result = await pick({
      parent: { providerID: "parent" as never, modelID: "big" as never },
      providers,
      promptText: "x".repeat(4_000),
      ownership: [{ providerID: "owned", modelID: "small" }],
    })
    expect(result.kind).toBe("placed")
    if (result.kind !== "placed") return
    expect(result.placement.providerID as string).toBe("unowned")
    const ownedEntry = result.candidates.find((c) => (c.providerID as string) === "owned")
    expect(ownedEntry?.ownership).toBe("owned-different-model")
    const unownedEntry = result.candidates.find((c) => (c.providerID as string) === "unowned")
    expect(unownedEntry?.ownership).toBe("unowned")
    expect(unownedEntry!.score!).toBeGreaterThan(ownedEntry!.score!)
    result.release()
  })

  test("a failed probe ranks below all reachable candidates", async () => {
    const broken = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/api/hardware") {
          return Response.json({ gpus: [], inference: { busy: false, in_flight: 0, slots_total: 1 } })
        }
        return new Response("not found", { status: 404 })
      },
    })
    const good = mockHost("ok-host", { loaded: "big" })
    const parent = mockHost("parent", {})
    const providers = {
      parent,
      good,
      broken: {
        id: "bad-host",
        options: { baseURL: `http://127.0.0.1:${broken.port}/v1` },
        models: Object.fromEntries(["big"].map((m) => [m, { id: m, capabilities: { toolcall: true } }])),
      } as unknown as ProviderInfo,
    } as unknown as Record<string, ProviderInfo>
    const result = await pick({
      parent: { providerID: "parent" as never, modelID: "big" as never },
      providers,
      promptText: "x".repeat(4_000),
    })
    expect(result.kind).toBe("placed")
    if (result.kind !== "placed") return
    expect(result.placement.providerID as string).toBe("ok-host")
    const brokenEntry = result.candidates.find((c) => (c.providerID as string) === "bad-host")
    expect(brokenEntry?.eligible).toBe(false)
    expect(brokenEntry?.score).toBeUndefined()
    broken.stop(true)
    result.release()
  })

  test("full fleet ranking: unowned-resident > unowned-cold > owned-same > owned-diff", async () => {
    const unownedResident = mockHost("u-resident", { loaded: "big" })
    const unownedCold = mockHost("u-cold", {})
    const ownedSame = mockHost("o-same", { loaded: "big" })
    const ownedDiff = mockHost("o-diff", { loaded: "big" })
    const parent = mockHost("parent", {})
    const providers = { parent, unownedResident, unownedCold, ownedSame, ownedDiff } as unknown as Record<string, ProviderInfo>
    const result = await pick({
      parent: { providerID: "parent" as never, modelID: "big" as never },
      providers,
      promptText: "x".repeat(4_000),
      ownership: [
        { providerID: "o-same", modelID: "big" },
        { providerID: "o-diff", modelID: "small" },
      ],
    })
    expect(result.kind).toBe("placed")
    if (result.kind !== "placed") return
    expect(result.placement.providerID as string).toBe("u-resident")
    const entries = result.candidates
      .filter((c) => c.eligible)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((c) => c.providerID)
    expect(entries[0]).toBe("u-resident")
    expect(entries[1]).toBe("u-cold")
    expect(entries[2]).toBe("o-same")
    expect(entries[3]).toBe("o-diff")
    const uResident = result.candidates.find((c) => (c.providerID as string) === "u-resident")
    const uCold = result.candidates.find((c) => (c.providerID as string) === "u-cold")
    const oSame = result.candidates.find((c) => (c.providerID as string) === "o-same")
    const oDiff = result.candidates.find((c) => (c.providerID as string) === "o-diff")
    expect(uResident?.ownership).toBe("unowned")
    expect(uCold?.ownership).toBe("unowned")
    expect(oSame?.ownership).toBe("owned-same-model")
    expect(oDiff?.ownership).toBe("owned-different-model")
  })
})
