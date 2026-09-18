import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { discoverGalleryHosts, type GalleryHost } from "@/local/model-gallery/hosts"
import { evaluateFitAcrossHosts, type FitCandidate } from "@/local/model-gallery/fit"
import { joinGalleryRows } from "@/local/model-gallery/join"
import { hardCompatibility } from "@/local/model-gallery/filter"
import { classifyRow } from "@/local/model-gallery/classify"
import { scoreRow } from "@/local/model-gallery/rank"
import { loadCatalogCandidates } from "@/local/model-gallery/catalog"
import { searchCatalog } from "@/local/model-gallery/search"
import { buildInstallPlan, InstallPlanError, planBytes } from "@/local/model-gallery/install"
import { listOperationsAcrossHosts, operationsClient, toGalleryOperation, TERMINAL_PHASES } from "@/local/model-gallery/operations"
import { copyPlan, inventoryAcrossHosts, manageClient, peerCopyPlan, sharesStore, sourceRemovalMode } from "@/local/model-gallery/manage"
import { createHuggingFaceCatalog } from "@/local/model-catalog/huggingface"
import type { ModelCandidate, ModelVariant } from "@/local/model-catalog/types"
import { InstanceHttpApi } from "../api"

// Serves the gallery data plane over the one typed surface the app and TUI
// share (model-gallery-ui task 5.7). All the reasoning lives in
// src/local/model-gallery/* as pure functions; this file only sequences them
// and shapes the wire response.

export const galleryHandlers = HttpApiBuilder.group(InstanceHttpApi, "gallery", (handlers) =>
  Effect.gen(function* () {
    const hosts = Effect.fn("GalleryHttpApi.hosts")(function* () {
      const found = yield* Effect.promise(() => discoverGalleryHosts())
      return found.map(toHostInfo)
    })

    const search = Effect.fn("GalleryHttpApi.search")(function* (ctx: { query: { q?: string; limit?: string } }) {
      const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined
      const result = yield* Effect.promise(() =>
        searchCatalog({ query: ctx.query.q, limit: Number.isFinite(limit) ? limit : undefined }),
      )
      return result.candidates.map((c) => toCandidateView(c, result.source))
    })

    const evaluate = Effect.fn("GalleryHttpApi.evaluate")(function* ({ payload }: { payload: EvaluatePayload }) {
      const discovered = yield* Effect.promise(() => discoverGalleryHosts())
      const wanted = new Set(payload.hostIds ?? [])
      const selected = wanted.size > 0 ? discovered.filter((h) => wanted.has(h.id)) : discovered

      const candidates = yield* Effect.promise(() => loadCatalogCandidates(payload.candidateIds))
      if (candidates.length === 0 || selected.length === 0) return []

      const fitCandidates: FitCandidate[] = candidates.map((c) => ({
        candidateId: c.id,
        model: c.repository,
        variants: c.variants
          .filter((v) => typeof v.totalBytes === "number" && v.totalBytes > 0)
          .map((v) => ({ name: v.quantization ?? v.id, fileBytes: v.totalBytes as number })),
        ...(c.parameterCount ? { paramsB: c.parameterCount / 1e9 } : {}),
        ...(payload.desiredContext ? { requestedCtx: payload.desiredContext } : {}),
      }))

      const fits = yield* Effect.promise(() => evaluateFitAcrossHosts(selected, fitCandidates))

      const rows = joinGalleryRows({
        hosts: selected,
        candidates: candidates.map((c) => ({
          candidateId: c.id,
          installedAliases: [c.repository, c.name],
        })),
        fits,
      })

      const byId = new Map(candidates.map((c) => [c.id, c]))
      const entries = rows.flatMap((row) => {
        const candidate = byId.get(row.candidateId)
        if (!candidate) return []

        const compatibility = hardCompatibility(row, candidate, {
          ...(payload.requiredCapabilities ? { requiredCapabilities: payload.requiredCapabilities } : {}),
          ...(payload.desiredContext ? { minContext: payload.desiredContext } : {}),
        })
        // Incompatible rows are dropped by default but can be requested, so
        // the UI can answer "why isn't this offered here" instead of just
        // omitting the host and leaving the user to guess.
        if (!compatibility.compatible && !payload.includeIncompatible) return []

        const host = selected.find((h) => h.id === row.hostId)
        const classification = classifyRow(row, candidate, host?.installedModelIDs ?? [])
        const ranked = scoreRow(row, candidate, {
          ...(payload.desiredContext ? { desiredContext: payload.desiredContext } : {}),
        })

        return [
          {
            candidateId: row.candidateId,
            hostId: row.hostId,
            hostName: row.hostName,
            online: row.online,
            installed: row.installed,
            ...(row.busy === undefined ? {} : { busy: row.busy }),
            fitKnown: row.fitKnown,
            state: classification.state,
            stateDetail: classification.detail,
            ...(classification.replaces ? { replaces: classification.replaces } : {}),
            compatible: compatibility.compatible,
            incompatibleReasons: compatibility.reasons,
            score: ranked.score,
            components: ranked.components,
            bestVariant: row.bestVariant ? toVariantFit(row.bestVariant) : null,
            recommendedVariant: row.recommendedVariant,
            variants: row.variants.map(toVariantFit),
            vramFreeMB: row.vramFreeMB,
            vramTotalMB: row.vramTotalMB,
          },
        ]
      })

      // Best first, stable on ties, so a refresh does not reshuffle under the
      // user's cursor.
      return entries.sort((a, b) => b.score - a.score || a.hostId.localeCompare(b.hostId))
    })

    // Shared by plan and install: the same resolution, so what the user
    // confirmed is exactly what gets submitted.
    const resolvePlan = Effect.fn("GalleryHttpApi.resolvePlan")(function* (payload: InstallPayload) {
      const discovered = yield* Effect.promise(() => discoverGalleryHosts())
      const host = discovered.find((h) => h.id === payload.hostId)
      if (!host) return yield* badRequest(`unknown host ${payload.hostId}`)
      if (!host.online) return yield* badRequest(`host ${host.name} is offline`)
      const [candidate] = yield* Effect.promise(() => loadCatalogCandidates([payload.candidateId]))
      if (!candidate) return yield* badRequest(`unknown candidate ${payload.candidateId}`)
      const variant = pickVariant(candidate, payload.variantId)
      if (!variant) return yield* badRequest(`candidate ${candidate.id} has no installable variant${payload.variantId ? ` ${payload.variantId}` : ""}`)
      const plan = yield* Effect.try({
        try: () => buildInstallPlan({ candidate, variant, modelId: payload.modelId }),
        catch: (e) => new InvalidRequestError({ message: e instanceof InstallPlanError ? e.message : String(e) }),
      })
      return { host, candidate, variant, plan }
    })

    const plan = Effect.fn("GalleryHttpApi.plan")(function* ({ payload }: { payload: InstallPayload }) {
      const r = yield* resolvePlan(payload)
      return {
        hostId: r.host.id,
        hostName: r.host.name,
        repository: r.plan.source_repository ?? r.candidate.repository,
        revision: r.plan.source_revision ?? "",
        modelId: r.plan.registration.model_id,
        backend: r.plan.registration.backend,
        license: r.candidate.license,
        bytes: planBytes(r.plan),
        artifacts: (r.plan.artifacts ?? []).map((a) => ({ path: a.path, bytes: a.size_bytes, role: a.role })),
      }
    })

    const install = Effect.fn("GalleryHttpApi.install")(function* ({ payload }: { payload: InstallPayload }) {
      const r = yield* resolvePlan(payload)
      const op = yield* Effect.tryPromise({
        try: () => operationsClient(r.host.baseURL).create(r.plan),
        catch: (e) => new InvalidRequestError({ message: `host ${r.host.name} refused the plan: ${String(e instanceof Error ? e.message : e)}` }),
      })
      return toGalleryOperation(r.host, op)
    })

    const operations = Effect.fn("GalleryHttpApi.operations")(function* () {
      const discovered = yield* Effect.promise(() => discoverGalleryHosts())
      return yield* Effect.promise(() => listOperationsAcrossHosts(discovered))
    })

    const cancel = Effect.fn("GalleryHttpApi.cancel")(function* ({ payload }: { payload: { hostId: string; id: string } }) {
      const discovered = yield* Effect.promise(() => discoverGalleryHosts())
      const host = discovered.find((h) => h.id === payload.hostId)
      if (!host) return yield* badRequest(`unknown host ${payload.hostId}`)
      const op = yield* Effect.tryPromise({
        try: () => operationsClient(host.baseURL).cancel(payload.id),
        catch: (e) => new InvalidRequestError({ message: String(e instanceof Error ? e.message : e) }),
      })
      return toGalleryOperation(host, op)
    })

    const installed = Effect.fn("GalleryHttpApi.installed")(function* () {
      const discovered = yield* Effect.promise(() => discoverGalleryHosts())
      return yield* Effect.promise(() => inventoryAcrossHosts(discovered))
    })

    const hostFor = Effect.fn("GalleryHttpApi.hostFor")(function* (hostId: string) {
      const discovered = yield* Effect.promise(() => discoverGalleryHosts())
      const host = discovered.find((h) => h.id === hostId)
      if (!host) return yield* badRequest(`unknown host ${hostId}`)
      if (!host.online) return yield* badRequest(`host ${host.name} is offline`)
      return host
    })

    const remove = Effect.fn("GalleryHttpApi.remove")(function* ({
      payload,
    }: {
      payload: { hostId: string; modelId: string; mode: "hide" | "delete" }
    }) {
      const host = yield* hostFor(payload.hostId)
      const client = manageClient(host.baseURL)
      const result = yield* Effect.tryPromise({
        try: () =>
          payload.mode === "hide"
            ? client.removeConfig(payload.modelId).then(() => ({ deletedFiles: [] as string[], missingFiles: [] as string[] }))
            : client.deleteModel(payload.modelId),
        catch: (e) => new InvalidRequestError({ message: String(e instanceof Error ? e.message : e) }),
      })
      return { hostId: host.id, modelId: payload.modelId, mode: payload.mode, deletedFiles: result.deletedFiles, missingFiles: result.missingFiles }
    })

    const setLoaded = (action: "load" | "unload") =>
      Effect.fn(`GalleryHttpApi.${action}`)(function* ({ payload }: { payload: { hostId: string; modelId: string } }) {
        const host = yield* hostFor(payload.hostId)
        const client = manageClient(host.baseURL)
        yield* Effect.tryPromise({
          try: () => (action === "load" ? client.load(payload.modelId) : client.unload(payload.modelId)),
          catch: (e) => new InvalidRequestError({ message: String(e instanceof Error ? e.message : e) }),
        })
        return { hostId: host.id, modelId: payload.modelId, loaded: action === "load" }
      })

    const copy = Effect.fn("GalleryHttpApi.copy")(function* ({
      payload,
    }: {
      payload: { fromHostId: string; toHostId: string; modelId: string; move?: boolean }
    }) {
      if (payload.fromHostId === payload.toHostId) return yield* badRequest("source and target host are the same")
      const discovered = yield* Effect.promise(() => discoverGalleryHosts())
      const inventories = yield* Effect.promise(() => inventoryAcrossHosts(discovered))
      const source = inventories.find((h) => h.hostId === payload.fromHostId)
      const target = inventories.find((h) => h.hostId === payload.toHostId)
      if (!source?.online) return yield* badRequest(`source host ${payload.fromHostId} is unknown or offline`)
      if (!target?.online) return yield* badRequest(`target host ${payload.toHostId} is unknown or offline`)
      const model = source.models.find((m) => m.id === payload.modelId)
      if (!model) return yield* badRequest(`${payload.modelId} is not installed on ${source.hostName}`)
      if (target.models.some((m) => m.id === model.id)) return yield* badRequest(`${model.id} is already on ${target.hostName}`)
      const targetHost = discovered.find((h) => h.id === target.hostId)!
      const sourceHost = discovered.find((h) => h.id === source.hostId)!

      // The source host has the files: let the target pull them straight from
      // it (works without provenance, no Hugging Face round trip). Fall back to
      // re-downloading from the recorded repository only if the target refuses
      // the peer plan and provenance exists.
      const ops = operationsClient(targetHost.baseURL)
      const peerResult = yield* Effect.promise(() =>
        ops
          .create(peerCopyPlan(sourceHost.baseURL, model))
          .then((op) => ({ ok: true as const, op }))
          .catch((e: unknown) => ({ ok: false as const, error: String(e instanceof Error ? e.message : e) })),
      )
      let op
      if (peerResult.ok) {
        op = peerResult.op
      } else {
        if (!model.sourceRepository)
          return yield* badRequest(`${target.hostName} refused to import ${model.id} from ${source.hostName} (${peerResult.error}); it has no recorded source repository to fall back to`)
        const candidate = yield* Effect.tryPromise({
          try: () =>
            createHuggingFaceCatalog().resolve({
              repository: model.sourceRepository!,
              ...(model.sourceRevision ? { revision: model.sourceRevision } : {}),
            }),
          catch: (e) => new InvalidRequestError({ message: `cannot resolve ${model.sourceRepository}: ${String(e instanceof Error ? e.message : e)}` }),
        })
        const plan = yield* Effect.try({
          try: () => copyPlan(candidate, model),
          catch: (e) => new InvalidRequestError({ message: String(e instanceof Error ? e.message : e) }),
        })
        op = yield* Effect.tryPromise({
          try: () => ops.create(plan),
          catch: (e) => new InvalidRequestError({ message: `host ${target.hostName} refused the plan: ${String(e instanceof Error ? e.message : e)}` }),
        })
      }

      const shared = sharesStore(source, target)
      const removal = payload.move ? sourceRemovalMode(source, inventories) : ("none" as const)
      if (removal !== "none") {
        // The source goes only once the target has the model; the host owns
        // the operation, so watch it rather than assume.
        yield* Effect.sync(() => {
          void watchThenRemove({
            opId: op.id,
            targetBaseURL: targetHost.baseURL,
            sourceBaseURL: sourceHost.baseURL,
            modelId: model.id,
            mode: removal,
          }).catch(() => undefined)
        })
      }
      return { operation: toGalleryOperation(targetHost, op), sharedStore: shared, sourceRemoval: removal }
    })

    return handlers
      .handle("hosts", hosts)
      .handle("installed", installed)
      .handle("remove", remove)
      .handle("load", setLoaded("load"))
      .handle("unload", setLoaded("unload"))
      .handle("copy", copy)
      .handle("search", search)
      .handle("evaluate", evaluate)
      .handle("plan", plan)
      .handle("install", install)
      .handle("operations", operations)
      .handle("cancel", cancel)
  }),
)

async function watchThenRemove(input: {
  opId: string
  targetBaseURL: string
  sourceBaseURL: string
  modelId: string
  mode: "hide" | "delete"
}): Promise<void> {
  const ops = operationsClient(input.targetBaseURL)
  const deadline = Date.now() + 6 * 60 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000))
    const op = await ops.get(input.opId).catch(() => undefined)
    if (!op) return
    if (!TERMINAL_PHASES.has(op.phase)) continue
    if (op.phase !== "succeeded") return
    const source = manageClient(input.sourceBaseURL)
    if (input.mode === "hide") await source.removeConfig(input.modelId).catch(() => undefined)
    else await source.deleteModel(input.modelId).catch(() => undefined)
    return
  }
}

function badRequest(message: string) {
  return Effect.fail(new InvalidRequestError({ message }))
}

type EvaluatePayload = {
  candidateIds: readonly string[]
  hostIds?: readonly string[]
  desiredContext?: number
  requiredCapabilities?: readonly string[]
  includeIncompatible?: boolean
}

type InstallPayload = {
  hostId: string
  candidateId: string
  variantId?: string
  modelId?: string
}

/** Explicit id, else the largest complete GGUF variant — the fit endpoint's recommendation is the UI's job to pass in. */
export function pickVariant(candidate: ModelCandidate, variantId?: string): ModelVariant | undefined {
  if (variantId) return candidate.variants.find((v) => v.id === variantId || v.quantization === variantId)
  return [...candidate.variants]
    .filter((v) => v.complete && typeof v.totalBytes === "number" && v.totalBytes > 0)
    .sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0))[0]
}

function toCandidateView(c: ModelCandidate, source: "live" | "seed") {
  return {
    id: c.id,
    name: c.name,
    author: c.author,
    repository: c.repository,
    parameterCount: c.parameterCount,
    trainedContext: c.trainedContext,
    license: c.license,
    pipelineTag: c.pipelineTag,
    capabilities: c.capabilities,
    downloads: c.downloads,
    likes: c.likes,
    freshness: source === "seed" ? "seed" : c.provenance.freshness,
    variants: c.variants.map((v) => ({
      id: v.id,
      quantization: v.quantization,
      format: v.format,
      totalBytes: v.totalBytes,
      complete: v.complete,
    })),
  }
}

function toHostInfo(host: GalleryHost) {
  return {
    id: host.id,
    name: host.name,
    baseURL: host.baseURL,
    source: host.source,
    online: host.online,
    installedModelIDs: host.installedModelIDs,
    defaultModel: host.defaultModel,
  }
}

function toVariantFit(v: {
  variantName: string
  fitLevel: string
  maxFitCtx: number
  vramRequiredMB: number
  modelMB: number
  reason: string
}) {
  return {
    variantName: v.variantName,
    fitLevel: v.fitLevel,
    maxFitCtx: v.maxFitCtx,
    vramRequiredMB: v.vramRequiredMB,
    modelMB: v.modelMB,
    reason: v.reason,
  }
}
