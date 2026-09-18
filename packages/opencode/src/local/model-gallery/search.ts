// Catalog search for the gallery API: live Hugging Face when reachable, the
// bundled seed when not (design.md decision 9 — degrade by source, never go
// blank). A query that looks like `owner/repo` is resolved directly so a
// pasted repository works without a search round trip.

import { createHuggingFaceCatalog } from "../model-catalog/huggingface"
import { loadSeedCatalog } from "../model-catalog/seed"
import type { ModelCandidate } from "../model-catalog/types"

export type SearchOptions = {
  query?: string
  limit?: number
  signal?: AbortSignal
  /** Injected in tests. */
  catalog?: {
    search: (input: { query?: string; limit?: number; signal?: AbortSignal }) => Promise<{ candidates: readonly ModelCandidate[] }>
    resolve: (input: { repository: string; signal?: AbortSignal }) => Promise<ModelCandidate>
  }
  seed?: () => readonly ModelCandidate[]
}

export type SearchResult = {
  candidates: ModelCandidate[]
  /** "live" when Hugging Face answered, "seed" when the bundled catalog served the result. */
  source: "live" | "seed"
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/
const DEFAULT_LIMIT = 25

export async function searchCatalog(options: SearchOptions = {}): Promise<SearchResult> {
  const query = (options.query ?? "").trim()
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 100))
  const catalog = options.catalog ?? createHuggingFaceCatalog()

  try {
    if (REPO_RE.test(query)) {
      const resolved = await catalog.resolve({ repository: query, signal: options.signal })
      return { candidates: [resolved], source: "live" }
    }
    const result = await catalog.search({ query, limit, signal: options.signal })
    if (result.candidates.length > 0 || query === "") return { candidates: [...result.candidates], source: "live" }
  } catch {
    // fall through to the seed
  }
  return { candidates: searchSeed(options.seed?.() ?? loadSeedCatalog().candidates, query, limit), source: "seed" }
}

export function searchSeed(seed: readonly ModelCandidate[], query: string, limit: number): ModelCandidate[] {
  const needle = query.toLowerCase()
  const hits = needle
    ? seed.filter((c) =>
        [c.id, c.name, c.repository, c.author ?? "", c.architecture ?? "", ...c.tags].some((s) =>
          s.toLowerCase().includes(needle),
        ),
      )
    : [...seed]
  hits.sort((a, b) => b.downloads - a.downloads || a.repository.localeCompare(b.repository))
  return hits.slice(0, limit)
}
