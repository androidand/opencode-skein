import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

// The one typed surface the model gallery is served from (model-gallery-ui
// task 5.7). The web app and the TUI both consume it through the generated
// SDK, so neither owns a private path into the catalog — a second entry point
// would let the two frontends drift into showing different verdicts for the
// same model on the same host, which is precisely the confusion this epic
// exists to remove.
//
// The shape mirrors the data plane deliberately: hosts, then rows. Ranking and
// classification are computed server-side and shipped as data, because they
// depend on llama-skein fit calls a browser cannot make and must not be
// reimplemented per frontend.

const root = "/gallery"

export const GalleryHostInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  baseURL: Schema.String,
  source: Schema.Literals(["mdns", "localhost", "lan"]),
  online: Schema.Boolean,
  installedModelIDs: Schema.Array(Schema.String),
  defaultModel: Schema.NullOr(Schema.String),
}).annotate({ identifier: "GalleryHostInfo" })
export interface GalleryHostInfo extends Schema.Schema.Type<typeof GalleryHostInfo> {}

export const GalleryVariantFit = Schema.Struct({
  variantName: Schema.String,
  fitLevel: Schema.String,
  maxFitCtx: Schema.Number,
  vramRequiredMB: Schema.Number,
  modelMB: Schema.Number,
  reason: Schema.String,
}).annotate({ identifier: "GalleryVariantFit" })

export const GalleryScoreComponent = Schema.Struct({
  kind: Schema.String,
  points: Schema.Number,
  detail: Schema.String,
  measured: Schema.Boolean,
}).annotate({ identifier: "GalleryScoreComponent" })

export const GalleryEntry = Schema.Struct({
  candidateId: Schema.String,
  hostId: Schema.String,
  hostName: Schema.String,
  online: Schema.Boolean,
  installed: Schema.Boolean,
  // Absent means unknown, NOT idle. An unreachable host must never read as
  // free, or a caller dispatches into a hole.
  busy: Schema.optional(Schema.Boolean),
  // False when llama-skein could not be asked. Distinct from "does not fit".
  fitKnown: Schema.Boolean,
  state: Schema.String,
  stateDetail: Schema.String,
  replaces: Schema.optional(Schema.String),
  compatible: Schema.Boolean,
  incompatibleReasons: Schema.Array(Schema.String),
  score: Schema.Number,
  components: Schema.Array(GalleryScoreComponent),
  bestVariant: Schema.NullOr(GalleryVariantFit),
  recommendedVariant: Schema.NullOr(Schema.String),
  variants: Schema.Array(GalleryVariantFit),
  vramFreeMB: Schema.Number,
  vramTotalMB: Schema.Number,
}).annotate({ identifier: "GalleryEntry" })
export interface GalleryEntry extends Schema.Schema.Type<typeof GalleryEntry> {}

export const GalleryEvaluatePayload = Schema.Struct({
  /** Repository ids or search terms already resolved to candidates. */
  candidateIds: Schema.Array(Schema.String),
  /** Restrict to these host ids; empty means every discovered host. */
  hostIds: Schema.optional(Schema.Array(Schema.String)),
  desiredContext: Schema.optional(Schema.Number),
  requiredCapabilities: Schema.optional(Schema.Array(Schema.String)),
  /** Include rows the hard filters rejected, so the UI can explain them. */
  includeIncompatible: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "GalleryEvaluatePayload" })

export const GalleryVariant = Schema.Struct({
  id: Schema.String,
  quantization: Schema.NullOr(Schema.String),
  format: Schema.String,
  totalBytes: Schema.NullOr(Schema.Number),
  complete: Schema.Boolean,
}).annotate({ identifier: "GalleryVariant" })

export const GalleryCandidate = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  author: Schema.NullOr(Schema.String),
  repository: Schema.String,
  parameterCount: Schema.NullOr(Schema.Number),
  trainedContext: Schema.NullOr(Schema.Number),
  license: Schema.NullOr(Schema.String),
  pipelineTag: Schema.NullOr(Schema.String),
  capabilities: Schema.Array(Schema.String),
  downloads: Schema.Number,
  likes: Schema.Number,
  /** "live" from Hugging Face, "seed" from the bundled catalog. */
  freshness: Schema.String,
  variants: Schema.Array(GalleryVariant),
}).annotate({ identifier: "GalleryCandidate" })
export interface GalleryCandidate extends Schema.Schema.Type<typeof GalleryCandidate> {}

export const GallerySearchQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  q: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.String),
})

export const GalleryOperation = Schema.Struct({
  hostId: Schema.String,
  hostName: Schema.String,
  id: Schema.String,
  phase: Schema.String,
  modelId: Schema.NullOr(Schema.String),
  bytesDownloaded: Schema.Number,
  bytesTotal: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  error: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
  warnings: Schema.Array(Schema.String),
  artifacts: Schema.Array(
    Schema.Struct({ path: Schema.String, bytesDownloaded: Schema.Number, bytesTotal: Schema.NullOr(Schema.Number) }),
  ),
}).annotate({ identifier: "GalleryOperation" })
export interface GalleryOperation extends Schema.Schema.Type<typeof GalleryOperation> {}

export const GalleryInstallPayload = Schema.Struct({
  hostId: Schema.String,
  candidateId: Schema.String,
  /** Variant id from the candidate; defaults to the host's recommended variant when omitted. */
  variantId: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
}).annotate({ identifier: "GalleryInstallPayload" })

export const GalleryInstallPlanView = Schema.Struct({
  hostId: Schema.String,
  hostName: Schema.String,
  repository: Schema.String,
  revision: Schema.String,
  modelId: Schema.String,
  backend: Schema.String,
  license: Schema.NullOr(Schema.String),
  bytes: Schema.Number,
  artifacts: Schema.Array(Schema.Struct({ path: Schema.String, bytes: Schema.Number, role: Schema.String })),
}).annotate({ identifier: "GalleryInstallPlanView" })

export const GalleryOperationRef = Schema.Struct({
  hostId: Schema.String,
  id: Schema.String,
}).annotate({ identifier: "GalleryOperationRef" })

export const GalleryApi = HttpApi.make("gallery").add(
  HttpApiGroup.make("gallery")
    .add(
      HttpApiEndpoint.get("search", `${root}/search`, {
        query: GallerySearchQuery,
        success: described(Schema.Array(GalleryCandidate), "Catalog candidates matching the query"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "gallery.search",
          summary: "Search the model catalog",
          description:
            "Live Hugging Face search (GGUF repositories), falling back to the bundled seed catalog when Hugging Face is unreachable. An `owner/repo` query resolves that repository directly.",
        }),
      ),
      HttpApiEndpoint.post("plan", `${root}/plan`, {
        query: WorkspaceRoutingQuery,
        payload: GalleryInstallPayload,
        success: described(GalleryInstallPlanView, "What an install would do, for confirmation"),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "gallery.plan",
          summary: "Preview an install plan",
          description: "Resolve candidate, variant and host into the immutable plan llama-skein would execute, without submitting it.",
        }),
      ),
      HttpApiEndpoint.post("install", `${root}/install`, {
        query: WorkspaceRoutingQuery,
        payload: GalleryInstallPayload,
        success: described(GalleryOperation, "The queued llama-skein operation"),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "gallery.install",
          summary: "Install a model on a host",
          description:
            "Submit the install plan to the chosen llama-skein host. Returns immediately with the operation; poll `gallery.operations` for progress. The host owns the operation — opencode never retries or replays it.",
        }),
      ),
      HttpApiEndpoint.get("operations", `${root}/operations`, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(GalleryOperation), "Active and recent operations across online hosts"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "gallery.operations",
          summary: "List host operations",
          description: "Install/download operations on every online llama-skein host, newest first.",
        }),
      ),
      HttpApiEndpoint.post("cancel", `${root}/operations/cancel`, {
        query: WorkspaceRoutingQuery,
        payload: GalleryOperationRef,
        success: described(GalleryOperation, "The operation after the cancel request"),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "gallery.cancel",
          summary: "Cancel a host operation",
          description: "Ask the owning llama-skein host to cancel an operation by id.",
        }),
      ),
      HttpApiEndpoint.get("hosts", `${root}/hosts`, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(GalleryHostInfo), "llama-skein hosts the gallery can offer"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "gallery.hosts",
          summary: "List gallery hosts",
          description:
            "Project opencode's existing llama-skein discovery into gallery hosts. Offline hosts are included so the UI can distinguish 'that host is down' from 'you have no such host'.",
        }),
      ),
      HttpApiEndpoint.post("evaluate", `${root}/evaluate`, {
        query: WorkspaceRoutingQuery,
        payload: GalleryEvaluatePayload,
        success: described(Schema.Array(GalleryEntry), "One ranked, classified entry per candidate/host pair"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "gallery.evaluate",
          summary: "Evaluate candidates across hosts",
          description:
            "Batch each candidate's variants through bounded concurrent hypothetical-fit calls to every compatible host, then filter, classify and rank. Entries carry an explained score breakdown rather than a bare number.",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware),
)
