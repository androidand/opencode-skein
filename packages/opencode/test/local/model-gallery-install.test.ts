import { describe, expect, test } from "bun:test"
import { buildInstallPlan, defaultModelId, InstallPlanError, planBytes } from "../../src/local/model-gallery/install"
import { searchCatalog, searchSeed } from "../../src/local/model-gallery/search"
import { listOperationsAcrossHosts, toGalleryOperation } from "../../src/local/model-gallery/operations"
import { pickVariant } from "../../src/server/routes/instance/httpapi/handlers/gallery"
import type { ModelCandidate, ModelVariant } from "../../src/local/model-catalog/types"
import type { GalleryHost } from "../../src/local/model-gallery/hosts"
import type { ModelOperation } from "../../src/local/llama-skein/gen/types.gen"

function variant(over: Partial<ModelVariant> = {}): ModelVariant {
  return {
    id: "Q4_K_M",
    repository: "unsloth/Qwen3-32B-GGUF",
    revision: "abc123",
    format: "gguf",
    quantization: "Q4_K_M",
    artifacts: [
      { path: "Qwen3-32B-Q4_K_M.gguf", role: "weights", size: 19_000_000_000, digest: "sha256:aa", downloadURL: "u" },
    ],
    totalBytes: 19_000_000_000,
    complete: true,
    ...over,
  }
}

function candidate(over: Partial<ModelCandidate> = {}): ModelCandidate {
  return {
    id: "unsloth/Qwen3-32B-GGUF",
    name: "Qwen3-32B-GGUF",
    author: "unsloth",
    repository: "unsloth/Qwen3-32B-GGUF",
    revision: null,
    architecture: "qwen3",
    parameterCount: 32e9,
    activeParameterCount: null,
    trainedContext: 131072,
    pipelineTag: "text-generation",
    capabilities: ["tools", "reasoning"],
    languages: ["en"],
    license: "apache-2.0",
    downloads: 1000,
    likes: 10,
    tags: ["gguf"],
    variants: [variant()],
    provenance: { source: "huggingface", freshness: "live" },
    policy: { allowed: true, reasons: [] },
    ...over,
  } as ModelCandidate
}

describe("buildInstallPlan", () => {
  test("gguf → llamacpp plan with the variant's artifacts and mapped capabilities", () => {
    const plan = buildInstallPlan({ candidate: candidate(), variant: variant() })
    expect(plan.source_repository).toBe("unsloth/Qwen3-32B-GGUF")
    expect(plan.source_revision).toBe("abc123")
    expect(plan.registration.backend).toBe("llamacpp")
    expect(plan.registration.model_id).toBe("qwen3-32b-q4_k_m")
    expect(plan.registration.capabilities).toEqual(["completion", "tool-use", "reasoning"])
    expect(plan.artifacts).toEqual([
      { path: "Qwen3-32B-Q4_K_M.gguf", size_bytes: 19_000_000_000, digest: "sha256:aa", role: "weights" },
    ])
    expect(planBytes(plan)).toBe(19_000_000_000)
  })
  test("refuses an incomplete variant and a variant with no immutable revision", () => {
    expect(() => buildInstallPlan({ candidate: candidate(), variant: variant({ complete: false }) })).toThrow(
      InstallPlanError,
    )
    expect(() => buildInstallPlan({ candidate: candidate(), variant: variant({ revision: "" }) })).toThrow(
      /revision/,
    )
  })
  test("projector artifacts register an mmproj role", () => {
    const v = variant({
      artifacts: [
        ...variant().artifacts,
        { path: "mmproj.gguf", role: "projection", size: 500_000_000, digest: null, downloadURL: "u" },
      ],
    })
    const plan = buildInstallPlan({ candidate: candidate(), variant: v })
    expect(plan.registration.mmproj_artifact_role).toBe("projector")
    expect(plan.artifacts?.[1]?.role).toBe("projector")
  })
  test("defaultModelId strips -GGUF and slugifies", () => {
    expect(defaultModelId(candidate({ name: "Muse Glimmer 30B-GGUF" }), variant({ quantization: "Q5_K_M" }))).toBe(
      "muse-glimmer-30b-q5_k_m",
    )
  })
})

describe("pickVariant", () => {
  test("explicit id or quantization wins", () => {
    const c = candidate({ variants: [variant({ id: "a", quantization: "Q8_0" }), variant({ id: "b", quantization: "Q4_K_M" })] })
    expect(pickVariant(c, "Q4_K_M")?.id).toBe("b")
    expect(pickVariant(c, "a")?.id).toBe("a")
  })
  test("defaults to the largest complete variant", () => {
    const c = candidate({
      variants: [
        variant({ id: "small", totalBytes: 1 }),
        variant({ id: "big", totalBytes: 9 }),
        variant({ id: "huge-incomplete", totalBytes: 99, complete: false }),
      ],
    })
    expect(pickVariant(c)?.id).toBe("big")
  })
})

describe("searchCatalog", () => {
  const seed = [candidate({ id: "seed/a", repository: "seed/a", name: "Alpha", downloads: 5 }), candidate({ id: "seed/b", repository: "seed/b", name: "Beta", downloads: 9 })]
  test("owner/repo resolves directly", async () => {
    const r = await searchCatalog({
      query: "unsloth/Qwen3-32B-GGUF",
      catalog: { search: async () => ({ candidates: [] }), resolve: async (i) => candidate({ id: i.repository }) },
      seed: () => seed,
    })
    expect(r.source).toBe("live")
    expect(r.candidates[0]?.id).toBe("unsloth/Qwen3-32B-GGUF")
  })
  test("falls back to the seed when Hugging Face fails, sorted by downloads", async () => {
    const r = await searchCatalog({
      query: "",
      catalog: {
        search: async () => {
          throw new Error("offline")
        },
        resolve: async () => {
          throw new Error("offline")
        },
      },
      seed: () => seed,
    })
    expect(r.source).toBe("seed")
    expect(r.candidates.map((c) => c.id)).toEqual(["seed/b", "seed/a"])
  })
  test("searchSeed matches name/repo/tags case-insensitively", () => {
    expect(searchSeed(seed, "alp", 10).map((c) => c.id)).toEqual(["seed/a"])
  })
})

describe("operations", () => {
  const host: GalleryHost = {
    id: "http://rocky:11435",
    name: "rocky",
    baseURL: "http://rocky:11435",
    source: "lan",
    online: true,
    installedModelIDs: [],
    defaultModel: null,
  }
  const op: ModelOperation = {
    id: "op_1",
    phase: "downloading",
    model_id: "qwen3-32b-q4_k_m",
    artifacts: [{ path: "a.gguf", bytes_downloaded: 10, bytes_total: 100 }],
    bytes_downloaded: 10,
    bytes_total: 100,
    created_at: "2026-09-18T00:00:00Z",
    updated_at: "2026-09-18T00:00:01Z",
  }
  test("toGalleryOperation carries host identity and nulls unknowns", () => {
    const g = toGalleryOperation(host, { ...op, bytes_total: undefined, model_id: undefined })
    expect(g.hostName).toBe("rocky")
    expect(g.bytesTotal).toBeNull()
    expect(g.modelId).toBeNull()
    expect(g.error).toBeNull()
  })
  test("a failing host contributes nothing; results are newest first", async () => {
    const dead: GalleryHost = { ...host, id: "dead", name: "dead" }
    const offline: GalleryHost = { ...host, id: "off", name: "off", online: false }
    const got = await listOperationsAcrossHosts([host, dead, offline], (h) => ({
      list: async () => {
        if (h.id === "dead") throw new Error("boom")
        return [op, { ...op, id: "op_2", updated_at: "2026-09-18T00:00:09Z" }]
      },
      create: async () => op,
      get: async () => op,
      cancel: async () => op,
    }))
    expect(got.map((o) => o.id)).toEqual(["op_2", "op_1"])
  })
})
