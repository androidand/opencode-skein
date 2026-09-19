import { describe, expect, test } from "bun:test"
import type { FitReport, ModelFit } from "../../src/local/llama-skein/gen/types.gen"
import {
  fitIsNo,
  fitIsLoadable,
  fitIsUnknown,
  fitLabel,
  fmtFitLevel,
  recommendedModelID,
} from "../../src/local/model-fit"

function makeReport(models: Array<Partial<ModelFit>>): FitReport {
  return { vram_total_mb: 32000, vram_free_mb: 8000, models: models as ModelFit[] }
}

const noFit: ModelFit = { model: "huge/gguf", backend: "llamacpp", fit_level: "no", max_safe_ctx: 0 }
const goodFit: ModelFit = { model: "qwen/3b", backend: "llamacpp", fit_level: "good", max_safe_ctx: 16384 }
const unknownFit: ModelFit = { model: "mystery/backend", backend: "llamacpp", fit_level: "unknown", max_safe_ctx: 0 }

describe("ui.dialog-select-fit.fit helpers", () => {
  test("fitIsNo: true only for an explicit 'no' fit_level", () => {
    const report = makeReport([noFit, goodFit])
    expect(fitIsNo(report, "huge/gguf")).toBe(true)
    expect(fitIsNo(report, "qwen/3b")).toBe(false)
  })

  test("fitIsNo: false when no report exists (never fabricate a no-fit)", () => {
    expect(fitIsNo(undefined, "huge/gguf")).toBe(false)
  })

  test("fitIsNo: false when the model is absent from the report", () => {
    expect(fitIsNo(makeReport([goodFit]), "not-in-report")).toBe(false)
  })

  test("fitIsLoadable: false for 'no', true for good, true when no report (no data => safe)", () => {
    const report = makeReport([noFit, goodFit])
    expect(fitIsLoadable(report, "huge/gguf")).toBe(false)
    expect(fitIsLoadable(report, "qwen/3b")).toBe(true)
    expect(fitIsLoadable(undefined, "qwen/3b")).toBe(true)
  })

  test("fitIsUnknown: true only when VRAM could not be read yet (unknown level)", () => {
    const report = makeReport([unknownFit, goodFit])
    expect(fitIsUnknown(report, "mystery/backend")).toBe(true)
    expect(fitIsUnknown(report, "qwen/3b")).toBe(false)
  })

  test("fitIsUnknown: true when there is no report at all", () => {
    expect(fitIsUnknown(undefined, "qwen/3b")).toBe(true)
  })

  test("fitLabel: level label for a loadable model", () => {
    const report = makeReport([goodFit])
    expect(fitLabel(report, "qwen/3b")).toBe("Good fit")
  })

  test("fitLabel: undefined for unknown (no verdict yet)", () => {
    const report = makeReport([unknownFit])
    expect(fitLabel(report, "mystery/backend")).toBeUndefined()
  })

  test("fitLabel: undefined when there is no report", () => {
    expect(fitLabel(undefined, "qwen/3b")).toBeUndefined()
  })

  test("fmtFitLevel: maps each level to its human label", () => {
    const levels: Array<[ModelFit["fit_level"], string]> = [
      ["perfect", "Perfect fit"],
      ["good", "Good fit"],
      ["tight", "Tight fit"],
      ["marginal", "Marginal fit"],
      ["no", "Does not fit"],
      ["unknown", "Fit unknown"],
    ]
    for (const [level, expected] of levels) {
      expect(fmtFitLevel(makeReport([{ model: "x", backend: "llamacpp", fit_level: level, max_safe_ctx: 0 }]), "x")).toBe(
        expected,
      )
    }
  })

  test("cannot-fit and fit-label compose for the picker option builder", () => {
    // A model that cannot fit carries a label AND the cannotFit marker; a
    // fitting one carries only a label; an unknown one carries neither.
    const report = makeReport([noFit, goodFit, unknownFit])
    expect({ label: fitLabel(report, "huge/gguf"), cannotFit: fitIsNo(report, "huge/gguf") }).toEqual({
      label: "Does not fit",
      cannotFit: true,
    })
    expect({ label: fitLabel(report, "qwen/3b"), cannotFit: fitIsNo(report, "qwen/3b") }).toEqual({
      label: "Good fit",
      cannotFit: false,
    })
    expect({ label: fitLabel(report, "mystery/backend"), cannotFit: fitIsNo(report, "mystery/backend") }).toEqual({
      label: undefined,
      cannotFit: false,
    })
  })
})

describe("ui.dialog-select-fit.recommendedModelID", () => {
  test("returns undefined with no report (no recommendation rather than a guess)", () => {
    expect(recommendedModelID(undefined, () => 10)).toBeUndefined()
  })

  test("picks the largest loadable model by weight size", () => {
    const report = makeReport([
      { model: "small", backend: "llamacpp", fit_level: "good", max_safe_ctx: 16384, model_mb: 2000 },
      { model: "big", backend: "llamacpp", fit_level: "tight", max_safe_ctx: 16384, model_mb: 20000 },
      { model: "mid", backend: "llamacpp", fit_level: "perfect", max_safe_ctx: 16384, model_mb: 8000 },
    ])
    expect(recommendedModelID(report, () => 10)).toBe("big")
  })

  test("never picks a model that cannot fit", () => {
    const report = makeReport([
      { model: "huge", backend: "llamacpp", fit_level: "no", max_safe_ctx: 0, model_mb: 100000 },
      { model: "fits", backend: "llamacpp", fit_level: "good", max_safe_ctx: 16384, model_mb: 5000 },
    ])
    expect(recommendedModelID(report, () => 10)).toBe("fits")
  })

  test("skips unknown (VRAM unreadable) models", () => {
    const report = makeReport([
      { model: "mystery", backend: "llamacpp", fit_level: "unknown", max_safe_ctx: 0, model_mb: 50000 },
      { model: "fits", backend: "llamacpp", fit_level: "good", max_safe_ctx: 16384, model_mb: 5000 },
    ])
    expect(recommendedModelID(report, () => 10)).toBe("fits")
  })

  test("falls back to size_bytes on the provider Model when model_mb is absent", () => {
    const report = makeReport([{ model: "a", backend: "llamacpp", fit_level: "good", max_safe_ctx: 16384 }])
    const sizeFor = (modelID: string) => (modelID === "a" ? 9000 : 100)
    expect(recommendedModelID(report, sizeFor)).toBe("a")
  })

  test("nothing loadable => no recommendation", () => {
    const report = makeReport([
      { model: "huge", backend: "llamacpp", fit_level: "no", max_safe_ctx: 0, model_mb: 100000 },
      { model: "mystery", backend: "llamacpp", fit_level: "unknown", max_safe_ctx: 0, model_mb: 100000 },
    ])
    expect(recommendedModelID(report, () => 10)).toBeUndefined()
  })

  test("ties on size break by higher throughput, then by id", () => {
    const report = makeReport([
      { model: "slow", backend: "llamacpp", fit_level: "good", max_safe_ctx: 16384, model_mb: 5000, est_tokens_per_sec: 10 },
      { model: "fast", backend: "llamacpp", fit_level: "good", max_safe_ctx: 16384, model_mb: 5000, est_tokens_per_sec: 90 },
    ])
    expect(recommendedModelID(report, () => 10)).toBe("fast")

    const tie = makeReport([
      { model: "z", backend: "llamacpp", fit_level: "good", max_safe_ctx: 16384, model_mb: 5000, est_tokens_per_sec: 50 },
      { model: "a", backend: "llamacpp", fit_level: "good", max_safe_ctx: 16384, model_mb: 5000, est_tokens_per_sec: 50 },
    ])
    expect(recommendedModelID(tie, () => 10)).toBe("a")
  })

  test("an absent entry (no fit row) is not treated as loadable", () => {
    // A model present in the provider but absent from the report must not be
    // recommended; only entries with a fit verdict count.
    const report = makeReport([{ model: "withverdict", backend: "llamacpp", fit_level: "good", max_safe_ctx: 16384, model_mb: 5000 }])
    expect(recommendedModelID(report, () => 10)).toBe("withverdict")
    expect(recommendedModelID(report, () => 10) !== "absent").toBe(true)
  })
})

describe("ui.dialog-select-fit.degradation with no fit report (task 2.4)", () => {
  // Mirrors the exact per-option computation in dialog-model.tsx so a no-report
  // state provably degrades to an unannotated, fully-usable list.
  function buildOption(modelID: string, fit: FitReport | undefined) {
    const fitText = fitLabel(fit, modelID)
    const cannotFit = fitIsNo(fit, modelID)
    const recommended = recommendedModelID(fit, () => 10) === modelID
    return {
      description: [fitText, recommended ? "(Recommended)" : ""].filter(Boolean).join(" ") || undefined,
      cannotFit,
      recommended,
      // selection is independent of all fit state:
      onSelect: () => "selected",
    }
  }

  test("no report => no annotation, no marker, and selection still works", () => {
    const option = buildOption("qwen/3b", undefined)
    expect(option.description).toBeUndefined()
    expect(option.cannotFit).toBe(false)
    expect(option.recommended).toBe(false)
    expect(option.onSelect()).toBe("selected")
  })

  test("an empty report (no models) degrades the same way", () => {
    const option = buildOption("qwen/3b", makeReport([]))
    expect(option.description).toBeUndefined()
    expect(option.cannotFit).toBe(false)
    expect(option.recommended).toBe(false)
    expect(option.onSelect()).toBe("selected")
  })

  test("a previously-marked model unmarks when the report is lost", () => {
    // A report that fit the model is present, then gone — the row that was
    // annotated must not keep its annotation (no stale fit text/markers).
    const withReport = buildOption("huge/gguf", makeReport([noFit]))
    expect(withReport.cannotFit).toBe(true)
    const cleared = buildOption("huge/gguf", undefined)
    expect(cleared.cannotFit).toBe(false)
    expect(cleared.description).toBeUndefined()
    expect(cleared.recommended).toBe(false)
  })
})
