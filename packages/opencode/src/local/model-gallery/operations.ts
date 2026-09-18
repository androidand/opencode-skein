// llama-skein model operations (install/download) seen from the gallery.
// opencode submits, observes and cancels by id; the host is the authority
// (model-gallery-ui task 7.2) — nothing here retries or replays on its own.

import { createClient, createConfig } from "../llama-skein/gen/client"
import { LlamaSkeinClient } from "../llama-skein/gen/sdk.gen"
import type { ModelInstallPlan, ModelOperation } from "../llama-skein/gen/types.gen"
import type { GalleryHost } from "./hosts"

export type GalleryOperation = {
  hostId: string
  hostName: string
  id: string
  phase: ModelOperation["phase"]
  modelId: string | null
  bytesDownloaded: number
  bytesTotal: number | null
  createdAt: string
  updatedAt: string
  error: { code: string; message: string } | null
  warnings: string[]
  artifacts: { path: string; bytesDownloaded: number; bytesTotal: number | null }[]
}

export type OperationsClient = {
  list: (signal?: AbortSignal) => Promise<ModelOperation[]>
  create: (plan: ModelInstallPlan, signal?: AbortSignal) => Promise<ModelOperation>
  get: (id: string, signal?: AbortSignal) => Promise<ModelOperation>
  cancel: (id: string, signal?: AbortSignal) => Promise<ModelOperation>
}

export function operationsClient(baseURL: string): OperationsClient {
  const llama = new LlamaSkeinClient({ client: createClient(createConfig({ baseUrl: baseURL })) })
  const unwrap = <T>(res: { data?: T; error?: unknown; response?: Response }): T => {
    if (res.error !== undefined || res.data === undefined) {
      const detail =
        typeof res.error === "object" && res.error && "error" in res.error
          ? String((res.error as { error: unknown }).error)
          : (res.response?.statusText ?? "request failed")
      throw new Error(detail)
    }
    return res.data
  }
  return {
    list: async (signal) => unwrap(await llama.listModelOperations({ signal })).operations ?? [],
    create: async (plan, signal) => unwrap(await llama.createModelOperation({ body: plan, signal })),
    get: async (id, signal) => unwrap(await llama.getModelOperation({ path: { id }, signal })),
    cancel: async (id, signal) => unwrap(await llama.cancelModelOperation({ path: { id }, signal })),
  }
}

export function toGalleryOperation(host: Pick<GalleryHost, "id" | "name">, op: ModelOperation): GalleryOperation {
  return {
    hostId: host.id,
    hostName: host.name,
    id: op.id,
    phase: op.phase,
    modelId: op.model_id ?? null,
    bytesDownloaded: op.bytes_downloaded,
    bytesTotal: op.bytes_total ?? null,
    createdAt: op.created_at,
    updatedAt: op.updated_at,
    error: op.error ? { code: op.error.code, message: op.error.message } : null,
    warnings: [...(op.warnings ?? [])],
    artifacts: op.artifacts.map((a) => ({
      path: a.path,
      bytesDownloaded: a.bytes_downloaded,
      bytesTotal: a.bytes_total ?? null,
    })),
  }
}

/** Operations on every online host, newest first. A host that fails to answer contributes nothing. */
export async function listOperationsAcrossHosts(
  hosts: readonly GalleryHost[],
  clientFor: (host: GalleryHost) => OperationsClient = (h) => operationsClient(h.baseURL),
  timeoutMs = 3_000,
): Promise<GalleryOperation[]> {
  const aborter = new AbortController()
  const timer = setTimeout(() => aborter.abort(), timeoutMs)
  try {
    const all = await Promise.all(
      hosts
        .filter((h) => h.online)
        .map(async (host) => {
          try {
            const ops = await clientFor(host).list(aborter.signal)
            return ops.map((op) => toGalleryOperation(host, op))
          } catch {
            return []
          }
        }),
    )
    return all.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } finally {
    clearTimeout(timer)
  }
}

export const TERMINAL_PHASES: ReadonlySet<ModelOperation["phase"]> = new Set(["succeeded", "cancelled", "failed"])
