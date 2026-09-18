// Turn a catalog candidate + chosen variant into the immutable install plan
// llama-skein executes (model-gallery-ui task 7.1). Pure: the HTTP layer picks
// the host, this decides what the host is asked to do.

import type { ModelCandidate, ModelVariant } from "../model-catalog/types"
import type { ModelInstallPlan, ModelCapability, ArtifactRole } from "../llama-skein/gen/types.gen"

export type InstallPlanInput = {
  candidate: ModelCandidate
  variant: ModelVariant
  /** Override for the registered model id; defaults to a slug of name + quantization. */
  modelId?: string
  ttl?: number
}

export class InstallPlanError extends Error {
  constructor(
    readonly code: "incomplete-variant" | "unknown-revision" | "unsupported-format" | "no-weights",
    message: string,
  ) {
    super(message)
  }
}

export function buildInstallPlan(input: InstallPlanInput): ModelInstallPlan {
  const { candidate, variant } = input
  if (!variant.complete) throw new InstallPlanError("incomplete-variant", `variant ${variant.id} is missing shards`)
  const revision = variant.revision || candidate.revision
  if (!revision) throw new InstallPlanError("unknown-revision", `no immutable revision for ${candidate.repository}`)
  const backend = backendFor(variant.format)
  if (!backend) throw new InstallPlanError("unsupported-format", `format ${variant.format} has no local backend`)
  const artifacts = variant.artifacts.filter((a) => typeof a.size === "number" && a.size > 0)
  if (!artifacts.some((a) => a.role === "weights")) throw new InstallPlanError("no-weights", `variant ${variant.id} has no weight files`)

  return {
    source_repository: candidate.repository,
    source_revision: revision,
    artifacts: artifacts.map((a) => ({
      path: a.path,
      size_bytes: a.size as number,
      ...(a.digest ? { digest: a.digest } : {}),
      role: roleFor(a.role),
    })),
    auto_discover_companions: true,
    registration: {
      model_id: input.modelId ?? defaultModelId(candidate, variant),
      display_name: candidate.name,
      backend,
      capabilities: capabilitiesFor(candidate),
      ...(artifacts.some((a) => a.role === "projection") ? { mmproj_artifact_role: "projector" as const } : {}),
      ...(input.ttl !== undefined ? { ttl: input.ttl } : {}),
    },
  }
}

export function defaultModelId(candidate: ModelCandidate, variant: ModelVariant): string {
  const base = candidate.name.replace(/-?gguf$/i, "")
  const quant = variant.quantization ? `-${variant.quantization}` : ""
  return `${base}${quant}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
}

/** Catalog roles → llama-skein roles: the two vocabularies differ on the projector and the catch-all. */
function roleFor(role: ModelVariant["artifacts"][number]["role"]): ArtifactRole {
  if (role === "projection") return "projector"
  if (role === "auxiliary") return "other"
  return role
}

function backendFor(format: ModelVariant["format"]): ModelInstallPlan["registration"]["backend"] | undefined {
  if (format === "gguf") return "llamacpp"
  if (format === "mlx") return "mlx"
  if (format === "safetensors" || format === "awq" || format === "gptq") return "vllm"
  return undefined
}

function capabilitiesFor(candidate: ModelCandidate): ModelCapability[] {
  const out = new Set<ModelCapability>(["completion"])
  for (const c of candidate.capabilities) {
    const k = c.toLowerCase()
    if (k === "tools" || k === "tool-use" || k === "function-calling") out.add("tool-use")
    if (k === "vision" || k === "image") out.add("vision")
    if (k === "reasoning" || k === "thinking") out.add("reasoning")
  }
  return [...out]
}

/** Total bytes the plan will download — what the confirmation step shows. */
export function planBytes(plan: ModelInstallPlan): number {
  return (plan.artifacts ?? []).reduce((sum, a) => sum + a.size_bytes, 0)
}
