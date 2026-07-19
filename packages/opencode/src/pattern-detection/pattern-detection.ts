import { Effect, Layer, Ref, Context } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

export interface PatternDetectionConfig {
  enabled: boolean
  maxRepetitions: number
  timeWindow: number
  similarityThreshold: number
}

export interface Interface {
  readonly detectPattern: (text: string, toolUsage?: string) => Effect.Effect<boolean>
  readonly updateConfig: (config: Partial<PatternDetectionConfig>) => Effect.Effect<void>
  readonly reset: () => Effect.Effect<void>
}

interface HistoryEntry {
  text: string
  toolUsage: string | undefined
  at: number
}

// fork: use bigram similarity matching loop.ts for consistent behavior
function normalize(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, " ")
}
function bigrams(text: string) {
  const grams = new Set<string>()
  for (let i = 0; i < text.length - 1; i++) grams.add(text.slice(i, i + 2))
  return grams
}
function bigramSimilarity(a: string, b: string): number {
  const na = normalize(a)
  const nb = normalize(b)
  if (na === nb) return 1
  if (!na || !nb) return 0
  const ga = bigrams(na)
  const gb = bigrams(nb)
  if (ga.size === 0 || gb.size === 0) return 0
  let intersection = 0
  for (const gram of ga) if (gb.has(gram)) intersection++
  return (2 * intersection) / (ga.size + gb.size)
}

const defaultConfig: PatternDetectionConfig = {
  enabled: true,
  maxRepetitions: 5,
  timeWindow: 5 * 60 * 1000,
  similarityThreshold: 0.7,
}

const make = Effect.gen(function* () {
  const config = yield* Ref.make<PatternDetectionConfig>(defaultConfig)
  const history = yield* Ref.make<HistoryEntry[]>([])

  const detectPattern = (text: string, toolUsage?: string) =>
    Effect.gen(function* () {
      const cfg = yield* Ref.get(config)
      if (!cfg.enabled) return false

      const now = Date.now()
      const cutoff = now - cfg.timeWindow

      yield* Ref.update(history, (h) => [
        ...h.filter((e) => e.at >= cutoff),
        { text, toolUsage, at: now },
      ])

      const entries = yield* Ref.get(history)
      const recent = entries.filter((e) => e.at >= cutoff)

      // fork: compare both text and toolUsage for pattern detection
      // toolUsage must match exactly, text uses bigram similarity
      const repetitions = recent.filter(
        (e) =>
          e !== recent[recent.length - 1] &&
          e.toolUsage === toolUsage &&
          bigramSimilarity(e.text, text) >= cfg.similarityThreshold,
      ).length

      return repetitions >= cfg.maxRepetitions
    })

  const updateConfig = (partial: Partial<PatternDetectionConfig>) =>
    Ref.update(config, (c) => ({ ...c, ...partial }))

  const reset = () => Ref.set(history, [])

  return { detectPattern, updateConfig, reset } satisfies Interface
})

export class Service extends Context.Service<Service, Interface>()("@opencode/PatternDetection") {}

export const layer = Layer.effect(Service, make)
export const defaultLayer = layer
export const node = LayerNode.make(layer, [])

export * as PatternDetection from "./pattern-detection"
