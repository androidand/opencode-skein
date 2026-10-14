import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { createClient, createConfig } from "../local/llama-skein/gen/client"
import { LlamaSkeinClient } from "../local/llama-skein/gen/sdk.gen"
import type { ModelFit } from "../local/llama-skein/gen/types.gen"
import {
  computeRecommendedCtx,
  extractMem,
  fmtCtxK,
  fmtGB,
  normalizeBaseURL,
  describePlacement,
  parseGpuLayers,
  buildCtxRows,
  placementAction,
  type MemSnapshot,
} from "../local/model-fit"

export function DialogModelCtx(props: { providerID: string; modelID: string }) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)
  const [mem, setMem] = createSignal<MemSnapshot | null>(null)
  const [fit, setFit] = createSignal<ModelFit | null>(null)

  const provider = createMemo(() => sync.data.provider.find((p) => p.id === props.providerID))

  // fork: the backend's *hard* n_ctx — the KV allocation every number here is
  // scaled against. `limit.context` is `max_safe_ctx`, a prompt budget that has
  // already had the output reserve and safety margin subtracted, so using it
  // skewed every recommendation. Prefer `/api/fit` `configured_ctx`; fall back to
  // `limit.contextMax`, which provider discovery also fills from `configured_ctx`.
  const current = createMemo(() => fit()?.configured_ctx ?? provider()?.models[props.modelID]?.limit.contextMax ?? 0)

  // Largest hard n_ctx this host can load, already capped at the model's TRAINED
  // context by llama-skein. 0 = unknown (non-llama-skein backend, VRAM unreadable).
  const maxFit = createMemo(() => fit()?.max_fit_ctx ?? 0)

  // True physical ceiling: no vramSafetyFrac/promptMarginFrac margin, the
  // actual OOM line. Selections are blocked against THIS, not maxFit — see
  // aboveCeiling's doc comment for why blocking on the conservative number
  // let this dialog recommend a value and then refuse that same value.
  const maxPhysical = createMemo(() => fit()?.max_physical_ctx ?? 0)

  const modelName = createMemo(() => provider()?.models[props.modelID]?.name ?? props.modelID)

  onMount(() => {
    const baseURL = provider()?.options?.["baseURL"] as string | undefined
    if (!baseURL) return
    const llamaClient = new LlamaSkeinClient({
      client: createClient(createConfig({ baseUrl: normalizeBaseURL(baseURL) })),
    })
    const poll = async () => {
      try {
        const res = await llamaClient.getHardware()
        if (res.data) setMem(extractMem(res.data))
      } catch {
        // backend may not support /api/hardware — ignore silently
      }
      try {
        const res = await llamaClient.getModelFit({ model: props.modelID })
        if (res.data) setFit(res.data)
      } catch {
        // backend may not support /api/fit — ceiling stays unknown, nothing is capped
      }
    }
    poll()
    const id = setInterval(poll, 15_000)
    onCleanup(() => clearInterval(id))
  })

  const recommended = createMemo(() => {
    const m = mem()
    const cur = current()
    if (!m || cur <= 0) return null
    return computeRecommendedCtx(m, cur, maxFit())
  })

  const options = createMemo(() => {
    const cur = current()
    const m = mem()
    const rec = recommended()
    const physMax = maxPhysical()
    const rows = buildCtxRows({ current: cur, recommended: rec, maxPhysical: physMax, mem: m })
    // Offload is a model setting, not a context one — it lives here only because
    // this is the per-model settings surface (per-model-placement-controls D1).
    const act = placementAction(fit())
    const placementRows: Array<{ value: number | "unpin" | "info" | "layers"; title: string; description: string; category: string; disabled?: boolean }> = []
    if (act) {
      placementRows.push({
        value: act.kind === "unpin" ? "unpin" : "info",
        title: `⚙ ${act.title}`,
        description: act.description,
        category: "Placement",
        disabled: act.kind === "info",
      })
    }
    // A deliberate pin: always available for a local llama-skein model, so the
    // operator can state an exact layer count rather than only clear one.
    if (fit()) {
      placementRows.push({
        value: "layers",
        title: "⚙ Pin GPU layers…",
        description: `write an explicit --n-gpu-layers (a deliberate pin; stops automatic placement for this model) · ${"reloads the model and drops its loaded state"}`,
        category: "Placement",
      })
    }
    return [...placementRows, ...rows]
  })

  const titleSuffix = createMemo(() => {
    const m = mem()
    const ceiling = maxPhysical()
    const safe = maxFit()
    const parts: string[] = []
    if (m) parts.push(`${fmtGB(m.freeMb)}/${fmtGB(m.totalMb)} GB ${m.label} free`)
    if (ceiling > 0) parts.push(`max ${fmtCtxK(ceiling)}`)
    if (safe > 0 && safe !== ceiling) parts.push(`safe ~${fmtCtxK(safe)}`)
    const placed = describePlacement(fit())
    if (placed) parts.push(placed)
    return parts.length ? ` · ${parts.join(" · ")}` : ""
  })

  function unpin() {
    if (busy()) return
    setBusy(true)
    dialog.clear()
    toast.show({ variant: "info", message: `Allowing offload for ${modelName()} — reloading model…` })
    sdk.client.local.model
      .setOffload(
        {
          providerID: props.providerID,
          modelID: props.modelID,
          directory: sdk.directory,
          localOffloadPayload: { unpin_placement: true },
        },
        { throwOnError: true },
      )
      .then((res) => {
        if (res.data === false) {
          toast.show({ variant: "error", message: "Offload change rejected — provider has no base URL" })
          return
        }
        void sync.refreshProviders()
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        toast.show({ variant: "error", message: `Failed to allow offload: ${msg}` })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  function pinLayers() {
    dialog.replace(() => (
      <DialogPrompt
        title={`Pin GPU layers — ${modelName()}`}
        placeholder="e.g. 99 (all layers on the GPU), 0 (CPU only)"
        description={() => (
          <text>Writes --n-gpu-layers verbatim and reloads the model. Cancel to leave placement alone.</text>
        )}
        onConfirm={(value) => {
          const n = parseGpuLayers(value)
          if (n === null) {
            toast.show({ variant: "error", message: `"${value.trim()}" is not a layer count (a whole number ≥ 0)` })
            return
          }
          setBusy(true)
          dialog.clear()
          toast.show({ variant: "info", message: `Pinning ${modelName()} to ${n} GPU layers — reloading model…` })
          sdk.client.local.model
            .setOffload(
              {
                providerID: props.providerID,
                modelID: props.modelID,
                directory: sdk.directory,
                localOffloadPayload: { n_gpu_layers: n },
              },
              { throwOnError: true },
            )
            .then((res) => {
              if (res.data === false) {
                toast.show({ variant: "error", message: "Layer pin rejected — provider has no base URL" })
                return
              }
              void sync.refreshProviders()
            })
            .catch((e: unknown) => {
              toast.show({ variant: "error", message: `Failed to pin layers: ${e instanceof Error ? e.message : String(e)}` })
            })
            .finally(() => setBusy(false))
        }}
        onCancel={() => dialog.clear()}
      />
    ))
  }

  function apply(ctx_size: number) {
    if (busy()) return
    setBusy(true)
    // Close immediately so the UI feels responsive; the model reload is slow.
    dialog.clear()
    toast.show({ variant: "info", message: `Context set to ${fmtCtxK(ctx_size)} — reloading model…` })
    sdk.client.local.model
      .setCtxSize(
        {
          providerID: props.providerID,
          modelID: props.modelID,
          directory: sdk.directory,
          localCtxSizePayload: { ctx_size },
        },
        { throwOnError: true },
      )
      .then((res) => {
        if (res.data === false) {
          toast.show({
            variant: "error",
            message: "Context size rejected — provider has no base URL",
          })
          return
        }
        void sync.refreshProviders()
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        // fork: the server attaches a `ref` to genuine backend failures
        // (middleware/error.ts) so the real reason — logged server-side, not
        // sent to the client — can be found with `grep <ref>` in server logs.
        const cause = e instanceof Error ? (e.cause as { body?: { data?: { ref?: unknown } } } | undefined) : undefined
        const ref = typeof cause?.body?.data?.ref === "string" ? cause.body.data.ref : undefined
        toast.show({
          variant: "error",
          message: `Failed to set context size: ${msg}${ref ? ` (ref: ${ref})` : ""}`,
        })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <DialogSelect<number | "unpin" | "info" | "layers">
      title={`${modelName()}${titleSuffix()}`}
      options={options()}
      skipFilter={true}
      current={current()}
      onSelect={(opt) => {
        if (opt.value === "unpin") return unpin()
        if (opt.value === "layers") return pinLayers()
        if (typeof opt.value === "number") apply(opt.value)
      }}
    />
  )
}
