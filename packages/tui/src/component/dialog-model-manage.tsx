import { createMemo, createResource, createSignal, onCleanup } from "solid-js"
import type { GalleryHostInventory, GalleryInstalledModel } from "@opencode-ai/sdk/v2"
import { DialogSelect } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useProject } from "../context/project"
import { fmtGB } from "../local/model-fit"
import { DialogGalleryOperations, DialogModelBrowse } from "./dialog-gallery"

// Installed models across every llama-skein host: load/unload, hide or
// delete, copy/move to another host. Hosts with the same store key serve the
// same files, so "hide" and "delete" are offered as distinct choices.

const REFRESH_MS = 5_000

type Wire = number | string | null | undefined
function n(v: Wire): number {
  if (typeof v === "number") return v
  const parsed = v === null || v === undefined ? 0 : Number(v)
  return Number.isFinite(parsed) ? parsed : 0
}

type Row =
  | { kind: "model"; host: GalleryHostInventory; model: GalleryInstalledModel }
  | { kind: "host"; host: GalleryHostInventory }
  | { kind: "browse" }
  | { kind: "operations" }

export function DialogModelManage() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const project = useProject()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)

  const [inventory, { refetch }] = createResource(async () => {
    const res = await sdk.client.gallery.installed({ workspace: project.workspace.current() })
    return (res.data ?? []) as GalleryHostInventory[]
  })
  const timer = setInterval(() => void refetch(), REFRESH_MS)
  onCleanup(() => clearInterval(timer))

  const storePeers = createMemo(() => {
    const byKey = new Map<string, string[]>()
    for (const h of inventory.latest ?? []) {
      if (!h.storeKey) continue
      byKey.set(h.storeKey, [...(byKey.get(h.storeKey) ?? []), h.hostName])
    }
    return byKey
  })

  const options = createMemo(() => {
    const rows: Array<{ value: Row; title: string; description?: string; footer?: string; category?: string; disabled?: boolean }> = []
    const list = inventory.latest ?? []
    if (list.length === 0) {
      rows.push({ value: { kind: "browse" }, title: inventory.loading ? "Loading hosts…" : "No llama-skein hosts found", disabled: true })
    }
    for (const host of list) {
      const shared = host.storeKey ? (storePeers().get(host.storeKey) ?? []).filter((x) => x !== host.hostName) : []
      const category = `${host.hostName}${host.online ? "" : " (offline)"}${shared.length ? ` · shares store with ${shared.join(", ")}` : ""}`
      if (host.models.length === 0) {
        rows.push({ value: { kind: "host", host }, title: host.online ? "no models installed" : "offline", category, disabled: true })
      }
      for (const m of [...host.models].sort((a, b) => Number(b.loaded) - Number(a.loaded) || a.id.localeCompare(b.id))) {
        rows.push({
          value: { kind: "model", host, model: m },
          title: m.id,
          description: [m.loaded ? "● loaded" : m.state !== "stopped" ? m.state : undefined, m.default ? "default" : undefined, m.activeOperationId ? "operation in progress" : undefined]
            .filter(Boolean)
            .join(" · ") || undefined,
          footer: [m.quantization, m.parameterSize, m.sizeBytes ? fmtGB(n(m.sizeBytes) / 1_048_576) : undefined, m.sourceRepository ?? undefined]
            .filter(Boolean)
            .join(" · "),
          category,
          disabled: !host.online,
        })
      }
    }
    rows.push({ value: { kind: "browse" }, title: "Browse & install models…", category: "Gallery" })
    rows.push({ value: { kind: "operations" }, title: "Downloads & operations…", category: "Gallery" })
    return rows
  })

  const workspace = () => project.workspace.current()

  async function run<T>(label: string, action: () => Promise<T>, done: (value: T) => string) {
    if (busy()) return
    setBusy(true)
    try {
      const value = await action()
      toast.show({ variant: "success", message: done(value) })
      await refetch()
      void sync.refreshProviders().catch(() => undefined)
    } catch (err) {
      toast.show({ variant: "error", message: `${label} failed: ${errorText(err)}` })
    } finally {
      setBusy(false)
    }
  }

  function toggleLoaded(row: Extract<Row, { kind: "model" }>) {
    const ref = { hostId: row.host.hostId, modelId: row.model.id }
    if (row.model.loaded)
      void run("Unload", () => sdk.client.gallery.unload({ workspace: workspace(), galleryModelRef: ref }, { throwOnError: true }), () => `${row.model.id} unloaded on ${row.host.hostName}`)
    else
      void run("Load", () => sdk.client.gallery.load({ workspace: workspace(), galleryModelRef: ref }, { throwOnError: true }), () => `${row.model.id} loading on ${row.host.hostName}`)
  }

  function remove(row: Extract<Row, { kind: "model" }>) {
    const shared = row.host.storeKey ? (storePeers().get(row.host.storeKey) ?? []).filter((x) => x !== row.host.hostName) : []
    const size = row.model.sizeBytes ? ` (${fmtGB(n(row.model.sizeBytes) / 1_048_576)})` : ""
    const choose = (mode: "hide" | "delete") =>
      void run(
        mode === "hide" ? "Hide" : "Delete",
        () => sdk.client.gallery.remove({ workspace: workspace(), galleryRemovePayload: { hostId: row.host.hostId, modelId: row.model.id, mode } }, { throwOnError: true }),
        (r) => {
          const d = (r.data as { deletedFiles: string[] } | undefined)?.deletedFiles?.length ?? 0
          return mode === "hide" ? `${row.model.id} hidden on ${row.host.hostName}; files kept` : `${row.model.id} deleted from ${row.host.hostName}${d ? ` (${d} file${d === 1 ? "" : "s"})` : ""}`
        },
      ).then(() => dialog.replace(() => <DialogModelManage />))
    dialog.replace(() => (
      <DialogSelect<"hide" | "delete" | "cancel">
        title={`Remove ${row.model.id} from ${row.host.hostName}?`}
        renderFilter={false}
        options={[
          {
            value: "hide",
            title: "Hide from this host",
            description: `removes the config entry only; files stay in the store${shared.length ? ` (also served by ${shared.join(", ")})` : ""}`,
          },
          {
            value: "delete",
            title: `Delete files${size}`,
            description: shared.length ? `⚠ frees disk on the shared store — ${shared.join(", ")} lose it too` : "frees disk on this host",
          },
          { value: "cancel", title: "Cancel" },
        ]}
        onSelect={(o) => {
          if (o.value === "cancel") dialog.replace(() => <DialogModelManage />)
          else choose(o.value)
        }}
      />
    ))
  }

  function copy(row: Extract<Row, { kind: "model" }>, move: boolean) {
    const targets = (inventory.latest ?? []).filter((h) => h.online && h.hostId !== row.host.hostId)
    if (targets.length === 0) {
      toast.show({ variant: "warning", message: "No other online host to copy to" })
      return
    }
    if (!row.model.sourceRepository) {
      toast.show({ variant: "warning", message: `${row.model.id} has no recorded source; it was not installed through llama-skein` })
      return
    }
    dialog.replace(() => (
      <DialogSelect<string>
        title={`${move ? "Move" : "Copy"} ${row.model.id} to…`}
        renderFilter={false}
        options={targets.map((t) => {
          const shared = row.host.storeKey !== null && t.storeKey === row.host.storeKey
          const has = t.models.some((m) => m.id === row.model.id)
          return {
            value: t.hostId,
            title: t.hostName,
            description: has ? "already has this model" : shared ? "shares the store — registers, nothing downloads" : `downloads ${row.model.sizeBytes ? fmtGB(n(row.model.sizeBytes) / 1_048_576) : "the model"} from ${row.model.sourceRepository}`,
            disabled: has,
          }
        })}
        onSelect={(o) => {
          const target = targets.find((t) => t.hostId === o.value)!
          const shared = row.host.storeKey !== null && target.storeKey === row.host.storeKey
          dialog.replace(() => (
            <DialogConfirm
              title={`${move ? "Move" : "Copy"} to ${target.hostName}?`}
              message={[
                `${row.model.id} from ${row.host.hostName} → ${target.hostName}.`,
                shared ? "Same store: registration only, no download." : `Re-downloads from ${row.model.sourceRepository} @ ${row.model.sourceRevision?.slice(0, 12) ?? "latest"}.`,
                move ? (shared ? "Source is hidden once the target has it." : "Source files are deleted once the target has it.") : "Source is left as is.",
              ].join("\n")}
              label={move ? "Move" : "Copy"}
              onConfirm={() =>
                void run(
                  move ? "Move" : "Copy",
                  () => sdk.client.gallery.copy({ workspace: workspace(), galleryCopyPayload: { fromHostId: row.host.hostId, toHostId: target.hostId, modelId: row.model.id, move } }, { throwOnError: true }),
                  () => `${move ? "Moving" : "Copying"} ${row.model.id} to ${target.hostName}`,
                ).then(() => dialog.replace(() => <DialogGalleryOperations />))
              }
              onCancel={() => dialog.replace(() => <DialogModelManage />)}
            />
          ))
        }}
      />
    ))
  }

  return (
    <DialogSelect<Row>
      title="Manage models"
      options={options()}
      actions={[
        {
          command: "gallery.dialog.toggle_loaded",
          title: "Load / unload",
          onTrigger: (o) => {
            const v = o.value as Row
            if (v.kind === "model") toggleLoaded(v)
          },
        },
        {
          command: "gallery.dialog.remove",
          title: "Hide / delete",
          onTrigger: (o) => {
            const v = o.value as Row
            if (v.kind === "model") remove(v)
          },
        },
        {
          command: "gallery.dialog.copy",
          title: "Copy to host",
          onTrigger: (o) => {
            const v = o.value as Row
            if (v.kind === "model") copy(v, false)
          },
        },
        {
          command: "gallery.dialog.move",
          title: "Move to host",
          onTrigger: (o) => {
            const v = o.value as Row
            if (v.kind === "model") copy(v, true)
          },
        },
      ]}
      onSelect={(o) => {
        const v = o.value as Row
        if (v.kind === "browse") dialog.replace(() => <DialogModelBrowse />)
        else if (v.kind === "operations") dialog.replace(() => <DialogGalleryOperations />)
        else if (v.kind === "model") toggleLoaded(v)
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
