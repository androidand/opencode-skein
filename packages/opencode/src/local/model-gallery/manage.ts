// Managing what is already installed: inventory per host, load/unload,
// hide-or-delete, and copy/move between hosts.
//
// Two llama-skein instances can serve one model store (same machine, same
// models_dir) while each decides in its own config what it shows. So a model
// has two independent facts per host — *files present in the store* and
// *registered in this host's config* — and every destructive action here
// says which one it touches: `hide` removes the config entry only, `delete`
// removes the artifact set (and therefore hides it on every host sharing the
// store). Copying onto a host that shares the source's store is a plan
// submission llama-skein short-circuits (files already there) — registration
// only, no download.

import { createClient, createConfig } from "../llama-skein/gen/client"
import { LlamaSkeinClient } from "../llama-skein/gen/sdk.gen"
import type { ApiModel, ModelInstallPlan } from "../llama-skein/gen/types.gen"
import type { ModelCandidate, ModelVariant } from "../model-catalog/types"
import { controlPlaneURL } from "./fit"
import type { GalleryHost } from "./hosts"
import { buildInstallPlan } from "./install"

export type InstalledModel = {
  id: string
  name: string | null
  sizeBytes: number | null
  loaded: boolean
  state: string
  default: boolean
  format: string | null
  quantization: string | null
  parameterSize: string | null
  sourceRepository: string | null
  sourceRevision: string | null
  artifactPaths: string[]
  activeOperationId: string | null
}

export type HostInventory = {
  hostId: string
  hostName: string
  online: boolean
  /** The store this host serves from; equal keys on two hosts mean shared files. */
  storeKey: string | null
  modelsDir: string | null
  models: InstalledModel[]
}

// `/api/models` carries more than the contract's ApiModel declares
// (installed, size, provenance) — read those fields loosely.
export type RawModel = ApiModel & {
  installed?: boolean
  size_bytes?: number
  default?: boolean
  source_repository?: string
  source_revision?: string
  artifact_paths?: string[]
  active_operation_id?: string
  details?: { format?: string; quantization?: string; parameter_size?: string }
}

export type ManageClient = {
  listModels: (signal?: AbortSignal) => Promise<RawModel[]>
  configInfo: (signal?: AbortSignal) => Promise<{ models_dir: string } | null>
  deleteModel: (id: string) => Promise<{ deletedFiles: string[]; missingFiles: string[]; configRemoved: boolean }>
  removeConfig: (id: string) => Promise<void>
  load: (id: string) => Promise<void>
  unload: (id: string) => Promise<void>
}

export function manageClient(baseURL: string): ManageClient {
  const llama = new LlamaSkeinClient({ client: createClient(createConfig({ baseUrl: controlPlaneURL(baseURL) })) })
  const fail = (what: string, res: { error?: unknown; response?: Response }): never => {
    const e = res.error
    const detail =
      typeof e === "string"
        ? e
        : typeof e === "object" && e && "error" in e
          ? String((e as { error: unknown }).error)
          : (res.response?.statusText ?? "request failed")
    throw new Error(`${what}: ${detail}`)
  }
  return {
    listModels: async (signal) => {
      const res = await llama.getApiModels({ signal })
      if (res.error !== undefined || !res.data) fail("list models", res)
      return res.data!.models as RawModel[]
    },
    configInfo: async (signal) => {
      const res = await llama.getConfigInfo({ signal }).catch(() => null)
      return res?.data ? { models_dir: res.data.models_dir } : null
    },
    deleteModel: async (id) => {
      const res = await llama.deleteModel({ path: { model: id } })
      if (res.error !== undefined || !res.data) fail(`delete ${id}`, res)
      return {
        deletedFiles: [...res.data!.deleted_files],
        missingFiles: [...res.data!.missing_files],
        configRemoved: res.data!.config_removed,
      }
    },
    removeConfig: async (id) => {
      const res = await llama.removeModelConfig({ path: { id } })
      if (res.error !== undefined) fail(`hide ${id}`, res)
    },
    load: async (id) => {
      const res = await llama.loadModel({ path: { model: id } })
      if (res.error !== undefined) fail(`load ${id}`, res)
    },
    unload: async (id) => {
      const res = await llama.unloadModel({ path: { model: id } })
      if (res.error !== undefined) fail(`unload ${id}`, res)
    },
  }
}

export function storeKeyFor(baseURL: string, modelsDir: string | null): string | null {
  if (!modelsDir) return null
  try {
    return `${new URL(baseURL).hostname.toLowerCase()}:${modelsDir.replace(/\/+$/, "")}`
  } catch {
    return null
  }
}

export function toInstalledModel(m: RawModel): InstalledModel {
  const details = m.details
  return {
    id: m.id,
    name: m.name ?? null,
    sizeBytes: m.size_bytes ?? null,
    loaded: m.loaded === true,
    state: m.state ?? "stopped",
    default: m.default === true,
    format: details?.format ?? null,
    quantization: details?.quantization ?? null,
    parameterSize: details?.parameter_size ?? null,
    sourceRepository: m.source_repository ?? null,
    sourceRevision: m.source_revision ?? null,
    artifactPaths: [...(m.artifact_paths ?? [])],
    activeOperationId: m.active_operation_id ?? null,
  }
}

export async function inventoryAcrossHosts(
  hosts: readonly GalleryHost[],
  clientFor: (host: GalleryHost) => ManageClient = (h) => manageClient(h.baseURL),
  timeoutMs = 4_000,
): Promise<HostInventory[]> {
  const aborter = new AbortController()
  const timer = setTimeout(() => aborter.abort(), timeoutMs)
  try {
    return await Promise.all(
      hosts.map(async (host): Promise<HostInventory> => {
        if (!host.online) return { hostId: host.id, hostName: host.name, online: false, storeKey: null, modelsDir: null, models: [] }
        const client = clientFor(host)
        const [models, info] = await Promise.all([
          client.listModels(aborter.signal).catch(() => [] as RawModel[]),
          client.configInfo(aborter.signal),
        ])
        const modelsDir = info?.models_dir ?? null
        return {
          hostId: host.id,
          hostName: host.name,
          online: true,
          modelsDir,
          storeKey: storeKeyFor(host.baseURL, modelsDir),
          models: models.filter((m) => m.installed !== false).map(toInstalledModel),
        }
      }),
    )
  } finally {
    clearTimeout(timer)
  }
}

export function sharesStore(a: HostInventory, b: HostInventory): boolean {
  return a.storeKey !== null && a.storeKey === b.storeKey
}

/**
 * A variant describing exactly the artifacts one host has installed, resolved
 * against the catalog at the recorded revision so sizes and digests are the
 * originals — the input `buildInstallPlan` needs to re-create the model
 * elsewhere under the same id.
 */
export function variantFromInstalled(candidate: ModelCandidate, installed: InstalledModel): ModelVariant | undefined {
  const wanted = new Set(installed.artifactPaths)
  if (wanted.size === 0) return undefined
  const artifacts = candidate.variants.flatMap((v) => v.artifacts).filter((a) => wanted.has(a.path))
  const seen = new Set<string>()
  const order = installed.artifactPaths
  const unique = artifacts
    .filter((a) => (seen.has(a.path) ? false : (seen.add(a.path), true)))
    .sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path))
  if (unique.length === 0) return undefined
  const revision = installed.sourceRevision ?? candidate.revision ?? unique[0]!.downloadURL.split("/resolve/")[1]?.split("/")[0] ?? ""
  const format = candidate.variants.find((v) => v.artifacts.some((a) => wanted.has(a.path)))?.format ?? "gguf"
  return {
    id: installed.id,
    repository: candidate.repository,
    revision,
    format,
    quantization: installed.quantization,
    artifacts: unique,
    totalBytes: unique.reduce((sum, a) => sum + (a.size ?? 0), 0),
    complete: unique.length === wanted.size,
  }
}

export function copyPlan(candidate: ModelCandidate, installed: InstalledModel): ModelInstallPlan {
  const variant = variantFromInstalled(candidate, installed)
  if (!variant) throw new Error(`cannot map ${installed.id}'s installed files to ${candidate.repository}`)
  return buildInstallPlan({ candidate, variant, modelId: installed.id })
}

/** What removing the source after a move should do: only files nobody else serves may be deleted. */
export function sourceRemovalMode(source: HostInventory, others: readonly HostInventory[]): "hide" | "delete" {
  return others.some((o) => o.hostId !== source.hostId && sharesStore(source, o)) ? "hide" : "delete"
}
