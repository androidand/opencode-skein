import { describe, expect, test } from "bun:test"
import type { GalleryEntry, GalleryOperation, GalleryVariantFit } from "@opencode-ai/sdk/v2/client"
import {
  canCopy,
  canInstall,
  canManage,
  copyTargets,
  deleteAffects,
  storePeers,
  defaultVariant,
  formatBytes,
  formatContext,
  formatCount,
  num,
  progressPercent,
  splitOperations,
  succeededSince,
} from "./models-gallery"

const fit = (variantName: string, fitLevel = "good"): GalleryVariantFit => ({
  variantName,
  fitLevel,
  maxFitCtx: 8192,
  vramRequiredMB: 4000,
  modelMB: 3500,
  reason: "",
})

const operation = (id: string, phase: string): GalleryOperation => ({
  hostId: "host",
  hostName: "Host",
  id,
  phase,
  modelId: "model",
  bytesDownloaded: 0,
  bytesTotal: 0,
  createdAt: "",
  updatedAt: "",
  error: { code: "", message: "" },
  warnings: [],
  artifacts: [],
})

describe("model gallery helpers", () => {
  test("coerces generated numeric sentinels to zero", () => {
    expect(num(42)).toBe(42)
    expect(num("NaN")).toBe(0)
    expect(num("Infinity")).toBe(0)
    expect(num(undefined)).toBe(0)
  })

  test("formats bytes, counts and context windows", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(4.2 * 1024 ** 3)).toBe("4.2 GB")
    expect(formatBytes(250 * 1024 ** 3)).toBe("250 GB")
    expect(formatCount(950)).toBe("950")
    expect(formatCount(1_400)).toBe("1.4K")
    expect(formatCount(12_400)).toBe("12K")
    expect(formatCount(7_000_000_000)).toBe("7B")
    expect(formatContext(0)).toBe("")
    expect(formatContext(512)).toBe("512")
    expect(formatContext(131072)).toBe("128K")
  })

  test("clamps progress percentage and tolerates unknown totals", () => {
    expect(progressPercent(0, 0)).toBe(0)
    expect(progressPercent(50, 200)).toBe(25)
    expect(progressPercent(300, 200)).toBe(100)
    expect(progressPercent("NaN", 200)).toBe(0)
  })

  test("splits operations into active and terminal", () => {
    const { active, recent } = splitOperations([
      operation("a", "downloading"),
      operation("b", "succeeded"),
      operation("c", "queued"),
      operation("d", "failed"),
    ])
    expect(active.map((op) => op.id)).toEqual(["a", "c"])
    expect(recent.map((op) => op.id)).toEqual(["b", "d"])
  })

  test("reports operations that newly reached succeeded", () => {
    const before = [operation("a", "downloading"), operation("b", "succeeded")]
    const after = [operation("a", "succeeded"), operation("b", "succeeded"), operation("c", "succeeded")]
    expect(succeededSince(before, after).map((op) => op.id)).toEqual(["a", "c"])
  })

  test("defaults the variant to the recommendation, then best fit, then first", () => {
    const variants = [fit("Q8_0", "tight"), fit("Q4_K_M", "perfect"), fit("Q2_K", "good")]
    const entry = (overrides: Partial<GalleryEntry>) =>
      ({ variants, recommendedVariant: "", bestVariant: fit("Q4_K_M"), ...overrides }) as GalleryEntry
    expect(defaultVariant(entry({ recommendedVariant: "Q2_K" }))?.variantName).toBe("Q2_K")
    expect(defaultVariant(entry({}))?.variantName).toBe("Q4_K_M")
    expect(defaultVariant(entry({ bestVariant: fit("missing") }))?.variantName).toBe("Q8_0")
    expect(defaultVariant(entry({ variants: [], bestVariant: fit("missing") }))).toBeUndefined()
  })

  const inventory = (hostId: string, storeKey: string, models: string[], online = true) => ({
    hostId,
    hostName: hostId,
    online,
    storeKey,
    models: models.map((id) => ({ id, sourceRepository: "", activeOperationId: "" })),
  })

  test("groups hosts by shared store and reports which peers lose a deleted model", () => {
    const a = inventory("a", "store-1", ["m1", "m2"])
    const b = inventory("b", "store-1", ["m1"])
    const c = inventory("c", "store-2", ["m1"])
    const d = inventory("d", "", ["m1"])
    const e = inventory("e", "", [])
    const all = [a, b, c, d, e]
    expect(storePeers(all, a).map((h) => h.hostId)).toEqual(["b"])
    expect(storePeers(all, d)).toEqual([])
    expect(deleteAffects(all, a, "m1").map((h) => h.hostId)).toEqual(["b"])
    expect(deleteAffects(all, a, "m2")).toEqual([])
  })

  test("marks copy targets as shared-store, already-present or offline", () => {
    const a = inventory("a", "store-1", ["m1"])
    const b = inventory("b", "store-1", [])
    const c = inventory("c", "store-2", ["m1"])
    const d = inventory("d", "", [], false)
    expect(copyTargets([a, b, c, d], a, "m1")).toEqual([
      { host: b, shared: true, hasModel: false, enabled: true },
      { host: c, shared: false, hasModel: true, enabled: false },
      { host: d, shared: false, hasModel: false, enabled: false },
    ])
  })

  test("gates copy and load/unload on provenance, host state and active operations", () => {
    expect(canCopy({ id: "m", sourceRepository: "org/repo", activeOperationId: "" })).toBe(true)
    expect(canCopy({ id: "m", sourceRepository: "", activeOperationId: "" })).toBe(false)
    expect(canCopy({ id: "m", sourceRepository: "org/repo", activeOperationId: "op" })).toBe(false)
    expect(canManage({ online: true }, { id: "m", sourceRepository: "", activeOperationId: "" })).toBe(true)
    expect(canManage({ online: false }, { id: "m", sourceRepository: "", activeOperationId: "" })).toBe(false)
    expect(canManage({ online: true }, { id: "m", sourceRepository: "", activeOperationId: "op" })).toBe(false)
  })

  test("only allows installing on online, compatible, idle hosts without the model", () => {
    expect(canInstall({ online: true, compatible: true, installed: false })).toBe(true)
    expect(canInstall({ online: false, compatible: true, installed: false })).toBe(false)
    expect(canInstall({ online: true, compatible: false, installed: false })).toBe(false)
    expect(canInstall({ online: true, compatible: true, installed: true })).toBe(false)
    expect(canInstall({ online: true, compatible: true, installed: false, busy: true })).toBe(false)
  })
})
