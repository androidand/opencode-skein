import { describe, expect, test } from "bun:test"
import {
  copyPlan,
  inventoryAcrossHosts,
  sharesStore,
  sourceRemovalMode,
  storeKeyFor,
  toInstalledModel,
  variantFromInstalled,
  type HostInventory,
  type InstalledModel,
  type RawModel,
} from "../../src/local/model-gallery/manage"
import type { GalleryHost } from "../../src/local/model-gallery/hosts"
import type { ModelCandidate } from "../../src/local/model-catalog/types"

const raw: RawModel = {
  id: "muse-glimmer-30b-q5-k-m",
  object: "model",
  state: "stopped",
  loaded: false,
  unlisted: false,
  installed: true,
  size_bytes: 19_194_274_848,
  source_repository: "unsloth/Muse-Glimmer-30B-GGUF",
  source_revision: "faa5b025c584",
  artifact_paths: ["Muse-Glimmer-30B-UD-Q5_K_M.gguf", "mmproj-kquant.gguf"],
  details: { format: "gguf", quantization: "Q5_K_M", parameter_size: "30B" },
}

function candidate(): ModelCandidate {
  const mk = (id: string, files: string[]) => ({
    id,
    repository: "unsloth/Muse-Glimmer-30B-GGUF",
    revision: "faa5b025c584",
    format: "gguf" as const,
    quantization: id,
    artifacts: files.map((path) => ({
      path,
      role: path.startsWith("mmproj") ? ("projection" as const) : ("weights" as const),
      size: path.startsWith("mmproj") ? 500 : 19_000,
      digest: null,
      downloadURL: `https://hf/unsloth/Muse-Glimmer-30B-GGUF/resolve/faa5b025c584/${path}`,
    })),
    totalBytes: 1,
    complete: true,
  })
  return {
    id: "unsloth/Muse-Glimmer-30B-GGUF",
    name: "Muse-Glimmer-30B-GGUF",
    author: "unsloth",
    repository: "unsloth/Muse-Glimmer-30B-GGUF",
    revision: "faa5b025c584",
    architecture: null,
    parameterCount: 30e9,
    activeParameterCount: null,
    trainedContext: null,
    pipelineTag: null,
    capabilities: ["vision"],
    languages: [],
    license: "apache-2.0",
    downloads: 1,
    likes: 0,
    tags: [],
    variants: [
      mk("Q4_K_M", ["Muse-Glimmer-30B-UD-Q4_K_M.gguf", "mmproj-kquant.gguf"]),
      mk("Q5_K_M", ["Muse-Glimmer-30B-UD-Q5_K_M.gguf", "mmproj-kquant.gguf"]),
    ],
    provenance: { source: "huggingface", freshness: "live" },
    policy: { allowed: true, reasons: [] },
  } as ModelCandidate
}

describe("inventory", () => {
  test("toInstalledModel reads provenance and details", () => {
    const m = toInstalledModel(raw)
    expect(m.sourceRepository).toBe("unsloth/Muse-Glimmer-30B-GGUF")
    expect(m.quantization).toBe("Q5_K_M")
    expect(m.artifactPaths).toHaveLength(2)
    expect(m.loaded).toBe(false)
  })
  test("storeKey is hostname + models_dir; two instances on one machine and dir share a store", () => {
    expect(storeKeyFor("http://gpuhost1:11435/v1", "/models/")).toBe("gpuhost1:/models")
    expect(storeKeyFor("http://gpuhost1:8080/v1", "/models")).toBe("gpuhost1:/models")
    expect(storeKeyFor("http://other:8080/v1", "/models")).not.toBe("gpuhost1:/models")
    expect(storeKeyFor("http://gpuhost1:8080/v1", null)).toBeNull()
    expect(storeKeyFor("http://gpuhost1:8080/v1", "/models", "abc")).toBe("store:abc")
    expect(storeKeyFor("http://other:8080/v1", "/nfs/models", "abc")).toBe("store:abc")
  })
  test("inventoryAcrossHosts skips offline hosts and tolerates a host that fails", async () => {
    const host = (id: string, online = true): GalleryHost => ({ id, name: id, baseURL: `http://${id}:1/v1`, source: "lan", online, installedModelIDs: [], defaultModel: null })
    const got = await inventoryAcrossHosts([host("a"), host("b"), host("c", false)], (h) => ({
      listModels: async () => (h.id === "b" ? Promise.reject(new Error("boom")) : [raw]),
      configInfo: async () => ({ models_dir: "/store" }),
      deleteModel: async () => ({ deletedFiles: [], missingFiles: [], configRemoved: true }),
      removeConfig: async () => undefined,
      load: async () => undefined,
      unload: async () => undefined,
    }))
    expect(got.map((g) => [g.hostId, g.online, g.models.length, g.storeKey])).toEqual([
      ["a", true, 1, "a:/store"],
      ["b", true, 0, "b:/store"],
      ["c", false, 0, null],
    ])
  })
})

describe("copy / move", () => {
  const installed: InstalledModel = toInstalledModel(raw)
  test("variantFromInstalled picks exactly the installed artifacts at the recorded revision", () => {
    const v = variantFromInstalled(candidate(), installed)!
    expect(v.artifacts.map((a) => a.path)).toEqual(["Muse-Glimmer-30B-UD-Q5_K_M.gguf", "mmproj-kquant.gguf"])
    expect(v.revision).toBe("faa5b025c584")
    expect(v.complete).toBe(true)
    expect(v.quantization).toBe("Q5_K_M")
  })
  test("copyPlan keeps the model id and registers the projector", () => {
    const plan = copyPlan(candidate(), installed)
    expect(plan.registration.model_id).toBe("muse-glimmer-30b-q5-k-m")
    expect(plan.registration.mmproj_artifact_role).toBe("projector")
    expect(plan.artifacts?.map((a) => a.role)).toEqual(["weights", "projector"])
  })
  test("a model whose files are not in the catalog cannot be copied", () => {
    expect(() => copyPlan(candidate(), { ...installed, artifactPaths: ["unknown.gguf"] })).toThrow(/cannot map/)
  })
  test("source removal after a move hides when another host shares the store, deletes otherwise", () => {
    const inv = (hostId: string, storeKey: string | null): HostInventory => ({ hostId, hostName: hostId, online: true, storeKey, modelsDir: null, models: [] })
    const a = inv("a", "m:/store")
    expect(sharesStore(a, inv("b", "m:/store"))).toBe(true)
    expect(sourceRemovalMode(a, [a, inv("b", "m:/store")])).toBe("hide")
    expect(sourceRemovalMode(a, [a, inv("b", "other:/store")])).toBe("delete")
    expect(sourceRemovalMode(inv("a", null), [inv("b", null)])).toBe("delete")
  })
})
