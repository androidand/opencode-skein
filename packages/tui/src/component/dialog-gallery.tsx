import { createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js"
import type { GalleryCandidate, GalleryEntry, GalleryInstallPlanView, GalleryOperation } from "@opencode-ai/sdk/v2"
import { DialogSelect } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useProject } from "../context/project"
import { fmtCtxK, fmtGB } from "../local/model-fit"

// The TUI half of the model gallery (model-gallery-ui §8): browse the catalog,
// see per-host fit, confirm an immutable install plan, watch the llama-skein
// operation, and land in the picker with the new model registered. Every
// verdict comes from the shared /gallery API — nothing is re-derived here.

const SEARCH_DEBOUNCE_MS = 350
const OPERATIONS_POLL_MS = 2_000
const TERMINAL = new Set(["succeeded", "cancelled", "failed"])

// The generated SDK types numbers as `number | "Infinity" | "-Infinity" | "NaN"`.
type Wire = number | string | null | undefined
function n(v: Wire): number {
  if (typeof v === "number") return v
  if (v === null || v === undefined) return 0
  const parsed = Number(v)
  return Number.isFinite(parsed) ? parsed : 0
}

function fmtBytes(bytes: Wire): string {
  const b = n(bytes)
  if (!b) return "?"
  return fmtGB(b / 1_048_576)
}

function fmtParams(raw: Wire): string | undefined {
  const count = n(raw)
  if (!count) return undefined
  return count >= 1e9 ? `${(count / 1e9).toFixed(count >= 1e10 ? 0 : 1)}B` : `${Math.round(count / 1e6)}M`
}

function fmtCount(raw: Wire): string {
  const v = n(raw)
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`
  return String(v)
}

type BrowseRow = { kind: "candidate"; candidate: GalleryCandidate } | { kind: "operations" } | { kind: "none" }

export function DialogModelBrowse(props: { initialQuery?: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const project = useProject()
  const [query, setQuery] = createSignal(props.initialQuery ?? "")
  const [debounced, setDebounced] = createSignal(props.initialQuery ?? "")

  createEffect(
    on(query, (q) => {
      const timer = setTimeout(() => setDebounced(q.trim()), SEARCH_DEBOUNCE_MS)
      onCleanup(() => clearTimeout(timer))
    }),
  )

  const [results] = createResource(debounced, async (q) => {
    const res = await sdk.client.gallery.search({ workspace: project.workspace.current(), q, limit: "30" })
    return (res.data ?? []) as GalleryCandidate[]
  })

  const options = createMemo(() => {
    const rows: Array<{ value: BrowseRow; title: string; description?: string; footer?: string; category?: string; disabled?: boolean }> = [
      {
        value: { kind: "operations" },
        title: "Downloads & operations…",
        description: "installs in progress on your hosts",
        category: "Gallery",
      },
    ]
    const list = results.latest ?? []
    const seed = list.some((c) => c.freshness === "seed")
    if (results.loading && list.length === 0) {
      rows.push({ value: { kind: "none" }, title: "Searching…", disabled: true, category: "Catalog" })
      return rows
    }
    for (const c of list) {
      const meta = [c.author, fmtParams(c.parameterCount), c.license].filter(Boolean).join(" · ")
      rows.push({
        value: { kind: "candidate", candidate: c },
        title: c.name,
        description: meta || undefined,
        footer:
          c.variants.length > 0
            ? `${fmtCount(c.downloads)}↓ · ${c.variants.length} variant${c.variants.length === 1 ? "" : "s"}`
            : `${fmtCount(c.downloads)}↓`,
        category: seed ? "Catalog (offline seed)" : "Catalog",
      })
    }
    if (list.length === 0 && !results.loading)
      rows.push({
        value: { kind: "none" },
        title: debounced() ? `Nothing matches "${debounced()}"` : "Type to search Hugging Face, or paste owner/repo",
        disabled: true,
        category: "Catalog",
      })
    return rows
  })

  return (
    <DialogSelect<BrowseRow>
      title="Browse models"
      placeholder="Search Hugging Face GGUF models or paste owner/repo"
      options={options()}
      skipFilter={true}
      flat={true}
      onFilter={setQuery}
      onSelect={(option) => {
        const v = option.value
        if (v.kind === "operations") dialog.replace(() => <DialogGalleryOperations />)
        else if (v.kind === "candidate") dialog.replace(() => <DialogModelCandidate candidate={v.candidate} />)
      }}
    />
  )
}

type CandidateRow =
  | { kind: "host"; entry: GalleryEntry }
  | { kind: "variant"; entry: GalleryEntry; variant: GalleryEntry["variants"][number] }
  | { kind: "info" }
  | { kind: "back" }

export function DialogModelCandidate(props: { candidate: GalleryCandidate }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const [expanded, setExpanded] = createSignal<string | undefined>()
  const [planning, setPlanning] = createSignal(false)

  const [entries] = createResource(async () => {
    const res = await sdk.client.gallery.evaluate({
      workspace: project.workspace.current(),
      galleryEvaluatePayload: { candidateIds: [props.candidate.id], includeIncompatible: true },
    })
    return (res.data ?? []) as GalleryEntry[]
  })

  const options = createMemo(() => {
    const c = props.candidate
    const rows: Array<{ value: CandidateRow; title: string; description?: string; footer?: string; category?: string; disabled?: boolean }> = []
    rows.push({
      value: { kind: "info" },
      title: c.repository,
      description: [fmtParams(c.parameterCount), n(c.trainedContext) ? `${fmtCtxK(n(c.trainedContext))} ctx` : undefined, c.license, ...c.capabilities]
        .filter(Boolean)
        .join(" · "),
      disabled: true,
      category: "Candidate",
    })
    const list = entries.latest ?? []
    if (entries.loading && list.length === 0) {
      rows.push({ value: { kind: "info" }, title: "Asking your hosts how it would fit…", disabled: true, category: "Hosts" })
      return rows
    }
    if (list.length === 0) {
      rows.push({ value: { kind: "info" }, title: "No llama-skein host can be asked right now", disabled: true, category: "Hosts" })
    }
    for (const e of list) {
      const best = e.bestVariant
      const fit = !e.online
        ? "offline"
        : !e.fitKnown
          ? "fit unknown"
          : best
            ? `${best.variantName} · ${best.fitLevel} · ${fmtCtxK(n(best.maxFitCtx))} ctx`
            : "does not fit"
      rows.push({
        value: { kind: "host", entry: e },
        title: e.hostName,
        description: e.compatible ? `${e.state}${e.stateDetail ? ` — ${e.stateDetail}` : ""}` : e.incompatibleReasons.join("; "),
        footer: `${fit} · VRAM ${fmtGB(n(e.vramFreeMB))} free of ${fmtGB(n(e.vramTotalMB))}`,
        category: "Hosts",
        disabled: !e.online || !e.compatible,
      })
      if (expanded() === e.hostId) {
        for (const v of e.variants) {
          rows.push({
            value: { kind: "variant", entry: e, variant: v },
            title: `  ${v.variantName}`,
            description: v.reason || undefined,
            footer: `${v.fitLevel} · ${fmtCtxK(n(v.maxFitCtx))} ctx · ${fmtGB(n(v.modelMB))}`,
            category: "Hosts",
            disabled: v.fitLevel === "no",
          })
        }
      }
    }
    rows.push({ value: { kind: "back" }, title: "← Back to search", category: "Gallery" })
    return rows
  })

  async function install(entry: GalleryEntry, variantName: string | undefined) {
    if (planning()) return
    setPlanning(true)
    const workspace = project.workspace.current()
    const payload = { hostId: entry.hostId, candidateId: props.candidate.id, ...(variantName ? { variantId: variantName } : {}) }
    try {
      const plan = await sdk.client.gallery.plan({ workspace, galleryInstallPayload: payload }, { throwOnError: true })
      const p = plan.data as GalleryInstallPlanView
      dialog.replace(() => (
        <DialogConfirm
          title={`Install on ${p.hostName}?`}
          message={[
            `${p.repository} @ ${p.revision.slice(0, 12)}`,
            `Registers as "${p.modelId}" (${p.backend}); downloads ${fmtBytes(p.bytes)} in ${p.artifacts.length} file${p.artifacts.length === 1 ? "" : "s"}.`,
            p.license ? `License: ${p.license}.` : "License: unknown — check the model card.",
          ].join("\n")}
          label="Install"
          onConfirm={() => {
            void sdk.client.gallery
              .install({ workspace, galleryInstallPayload: payload }, { throwOnError: true })
              .then((res) => {
                const op = res.data as GalleryOperation
                toast.show({ variant: "success", message: `Installing ${p.modelId} on ${p.hostName}` })
                dialog.replace(() => <DialogGalleryOperations focus={op.id} />)
              })
              .catch((err) => toast.show({ variant: "error", message: `Install refused: ${errorText(err)}` }))
          }}
          onCancel={() => dialog.replace(() => <DialogModelCandidate candidate={props.candidate} />)}
        />
      ))
    } catch (err) {
      toast.show({ variant: "error", message: `Cannot plan install: ${errorText(err)}` })
    } finally {
      setPlanning(false)
    }
  }

  return (
    <DialogSelect<CandidateRow>
      title={props.candidate.name}
      options={options()}
      renderFilter={false}
      actions={[
        {
          command: "gallery.dialog.variants",
          title: "Choose variant",
          onTrigger: (option) => {
            const v = option.value as CandidateRow
            if (v.kind !== "host") return
            setExpanded(expanded() === v.entry.hostId ? undefined : v.entry.hostId)
          },
        },
      ]}
      onSelect={(option) => {
        const v = option.value as CandidateRow
        if (v.kind === "back") dialog.replace(() => <DialogModelBrowse />)
        else if (v.kind === "host") void install(v.entry, v.entry.recommendedVariant ?? v.entry.bestVariant?.variantName ?? undefined)
        else if (v.kind === "variant") void install(v.entry, v.variant.variantName)
      }}
    />
  )
}

type OperationRow = { kind: "op"; op: GalleryOperation } | { kind: "info" } | { kind: "back" }

export function DialogGalleryOperations(props: { focus?: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const project = useProject()
  const toast = useToast()
  const seenTerminal = new Set<string>()

  const [ops, { refetch }] = createResource(async () => {
    const res = await sdk.client.gallery.operations({ workspace: project.workspace.current() })
    return (res.data ?? []) as GalleryOperation[]
  })

  const timer = setInterval(() => void refetch(), OPERATIONS_POLL_MS)
  onCleanup(() => clearInterval(timer))

  // A finished install means a new model on that host: refresh the picker so
  // it shows up without a restart (§7.4).
  createEffect(() => {
    for (const op of ops.latest ?? []) {
      if (!TERMINAL.has(op.phase) || seenTerminal.has(op.id)) continue
      seenTerminal.add(op.id)
      if (op.phase === "succeeded") {
        void sync.refreshProviders().catch(() => undefined)
        toast.show({ variant: "success", message: `${op.modelId ?? "Model"} installed on ${op.hostName}` })
      } else if (op.phase === "failed") {
        toast.show({ variant: "error", message: `Install failed on ${op.hostName}: ${op.error?.message ?? op.error?.code ?? "unknown error"}` })
      }
    }
  })

  const options = createMemo(() => {
    const rows: Array<{ value: OperationRow; title: string; description?: string; footer?: string; category?: string; disabled?: boolean }> = []
    const list = ops.latest ?? []
    if (list.length === 0) {
      rows.push({
        value: { kind: "info" },
        title: ops.loading ? "Loading…" : "No downloads or installs in progress",
        disabled: true,
        category: "Operations",
      })
    }
    for (const op of list) {
      const total = n(op.bytesTotal)
      const pct = total ? Math.round((n(op.bytesDownloaded) / total) * 100) : undefined
      const progress =
        op.phase === "downloading" && pct !== undefined
          ? `${pct}% · ${fmtBytes(op.bytesDownloaded)} of ${fmtBytes(op.bytesTotal)}`
          : op.phase
      rows.push({
        value: { kind: "op", op },
        title: `${op.hostName} · ${op.modelId ?? op.id}`,
        description: op.error ? `${op.phase}: ${op.error.message}` : progress,
        footer: op.warnings.length ? op.warnings[0] : undefined,
        category: TERMINAL.has(op.phase) ? "Recent" : "Active",
      })
    }
    rows.push({ value: { kind: "back" }, title: "← Browse models", category: "Gallery" })
    return rows
  })

  return (
    <DialogSelect<OperationRow>
      title="Downloads & operations"
      options={options()}
      renderFilter={false}
      current={props.focus ? (options().find((r) => r.value.kind === "op" && r.value.op.id === props.focus)?.value as OperationRow | undefined) : undefined}
      actions={[
        {
          command: "gallery.dialog.cancel",
          title: "Cancel operation",
          onTrigger: (option) => {
            const v = option.value as OperationRow
            if (v.kind !== "op" || TERMINAL.has(v.op.phase)) return
            void sdk.client.gallery
              .cancel(
                { workspace: project.workspace.current(), galleryOperationRef: { hostId: v.op.hostId, id: v.op.id } },
                { throwOnError: true },
              )
              .then(() => void refetch())
              .catch((err) => toast.show({ variant: "error", message: `Cancel failed: ${errorText(err)}` }))
          },
        },
      ]}
      onSelect={(option) => {
        const v = option.value as OperationRow
        if (v.kind === "back") dialog.replace(() => <DialogModelBrowse />)
      }}
    />
  )
}

function errorText(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { message?: unknown; error?: { message?: unknown } }
    if (typeof e.error?.message === "string") return e.error.message
    if (typeof e.message === "string") return e.message
  }
  return String(err)
}
