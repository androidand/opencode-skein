import type {
  GalleryEntry,
  GalleryHostInventory,
  GalleryInstalledModel,
  GalleryOperation,
  GalleryVariantFit,
} from "@opencode-ai/sdk/v2/client"

export type Numeric = number | "NaN" | "Infinity" | "-Infinity"

export const TERMINAL_PHASES: ReadonlySet<string> = new Set(["succeeded", "cancelled", "failed"])

export function num(value: Numeric | undefined | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0
  return value
}

export function formatBytes(value: Numeric | undefined | null): string {
  const bytes = num(value)
  if (bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const scaled = bytes / Math.pow(1024, index)
  const digits = index === 0 ? 0 : scaled >= 100 ? 0 : 1
  return `${scaled.toFixed(digits)} ${units[index]}`
}

export function formatMegabytes(value: Numeric | undefined | null): string {
  return formatBytes(num(value) * 1024 * 1024)
}

export function formatCount(value: Numeric | undefined | null): string {
  const count = num(value)
  if (count >= 1_000_000_000) return `${trim(count / 1_000_000_000)}B`
  if (count >= 1_000_000) return `${trim(count / 1_000_000)}M`
  if (count >= 1_000) return `${trim(count / 1_000)}K`
  return `${Math.round(count)}`
}

export function formatParams(value: Numeric | undefined | null): string {
  const count = num(value)
  if (count <= 0) return ""
  return `${formatCount(count)}`
}

export function formatContext(value: Numeric | undefined | null): string {
  const ctx = num(value)
  if (ctx <= 0) return ""
  return ctx >= 1024 ? `${trim(ctx / 1024)}K` : `${ctx}`
}

function trim(value: number): string {
  const fixed = value >= 10 ? value.toFixed(0) : value.toFixed(1)
  return fixed.replace(/\.0$/, "")
}

export function progressPercent(downloaded: Numeric | undefined | null, total: Numeric | undefined | null): number {
  const done = num(downloaded)
  const all = num(total)
  if (all <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((done / all) * 100)))
}

export function isTerminal(phase: string): boolean {
  return TERMINAL_PHASES.has(phase)
}

export function splitOperations(operations: GalleryOperation[]) {
  const active: GalleryOperation[] = []
  const recent: GalleryOperation[] = []
  for (const op of operations) (isTerminal(op.phase) ? recent : active).push(op)
  return { active, recent }
}

export function defaultVariant(entry: Pick<GalleryEntry, "variants" | "recommendedVariant" | "bestVariant">) {
  const byName = (name: string | undefined) => (name ? entry.variants.find((v) => v.variantName === name) : undefined)
  return byName(entry.recommendedVariant) ?? byName(entry.bestVariant?.variantName) ?? entry.variants[0]
}

export function variantFor(entry: Pick<GalleryEntry, "variants">, name: string | undefined): GalleryVariantFit | undefined {
  return name ? entry.variants.find((v) => v.variantName === name) : undefined
}

export function canInstall(entry: Pick<GalleryEntry, "online" | "compatible" | "installed" | "busy">): boolean {
  return entry.online && entry.compatible && !entry.installed && !entry.busy
}

export function repositoryUrl(repository: string): string {
  return `https://huggingface.co/${repository}`
}

export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error) return error
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; data?: { message?: unknown } }
    if (typeof record.data?.message === "string") return record.data.message
    if (typeof record.message === "string") return record.message
  }
  return fallback
}

export function unwrap<T>(result: { data?: T; error?: unknown }, fallback: string): T {
  if (result.error !== undefined) throw new Error(errorMessage(result.error, fallback))
  if (result.data === undefined) throw new Error(fallback)
  return result.data
}

type Inventory = Pick<GalleryHostInventory, "hostId" | "hostName" | "online" | "storeKey"> & {
  models: Array<Pick<GalleryInstalledModel, "id">>
}
type Installed = Pick<GalleryInstalledModel, "id" | "sourceRepository" | "activeOperationId">

export function sharesStore(a: Pick<Inventory, "storeKey">, b: Pick<Inventory, "storeKey">): boolean {
  return !!a.storeKey && a.storeKey === b.storeKey
}

export function storePeers<T extends Inventory>(inventories: T[], host: Pick<Inventory, "hostId" | "storeKey">): T[] {
  return inventories.filter((other) => other.hostId !== host.hostId && sharesStore(other, host))
}

export function deleteAffects<T extends Inventory>(inventories: T[], host: Inventory, modelId: string): T[] {
  return storePeers(inventories, host).filter((peer) => peer.models.some((m) => m.id === modelId))
}

export type CopyTarget<T extends Inventory> = { host: T; shared: boolean; hasModel: boolean; enabled: boolean }

export function copyTargets<T extends Inventory>(inventories: T[], from: Inventory, modelId: string): CopyTarget<T>[] {
  return inventories
    .filter((host) => host.hostId !== from.hostId)
    .map((host) => {
      const shared = sharesStore(host, from)
      const hasModel = host.models.some((m) => m.id === modelId)
      return { host, shared, hasModel, enabled: host.online && !hasModel }
    })
}

export function canCopy(model: Installed): boolean {
  return !!model.sourceRepository && !model.activeOperationId
}

export function canManage(host: Pick<Inventory, "online">, model: Installed): boolean {
  return host.online && !model.activeOperationId
}

export function succeededSince(previous: GalleryOperation[], next: GalleryOperation[]): GalleryOperation[] {
  const before = new Map(previous.map((op) => [`${op.hostId}:${op.id}`, op.phase]))
  return next.filter((op) => op.phase === "succeeded" && before.get(`${op.hostId}:${op.id}`) !== "succeeded")
}
