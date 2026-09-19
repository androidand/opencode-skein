import { expect, test } from "bun:test"
import { createClient, createConfig } from "../../src/local/llama-skein/gen/client"
import { LlamaSkeinClient } from "../../src/local/llama-skein/gen/sdk.gen"
import type { FitReport } from "../../src/local/llama-skein/gen/types.gen"
import { normalizeBaseURL } from "../../src/local/model-fit"
import { fetchFitReportForProvider } from "../../src/component/dialog-model"

test("unreachable fit endpoint leaves the cache empty and never throws", async () => {
  // 127.0.0.1:1 has nothing listening, so getFitReport() rejects. The helper
  // swallows the rejection, returns undefined, and never writes to the cache —
  // exactly the "dialog opens at current speed with the endpoint unreachable"
  // behavior the task asks for.
  const cache: Record<string, FitReport> = {}
  const setCache = (updater: (prev: Record<string, FitReport>) => Record<string, FitReport>) => {
    Object.assign(cache, updater(cache))
  }
  const llamaClient = new LlamaSkeinClient({
    client: createClient(createConfig({ baseUrl: normalizeBaseURL("http://127.0.0.1:1") })),
  })
  const result = await fetchFitReportForProvider(llamaClient, "rocky", setCache)
  expect(result).toBeUndefined()
  expect(cache).toEqual({})
})

test("a fit report is cached per provider id", async () => {
  const cache: Record<string, FitReport> = {}
  const sample: FitReport = { vram_total_mb: 32000, vram_free_mb: 12000, models: [] }
  // Drive the success branch directly: a client that resolves a report populates
  // the cache keyed by provider id and returns it, so the dialog reuses it.
  const fakeClient = { getFitReport: async () => ({ data: sample }) } as unknown as LlamaSkeinClient
  const setCache = (updater: (prev: Record<string, FitReport>) => Record<string, FitReport>) => {
    Object.assign(cache, updater(cache))
  }
  const result = await fetchFitReportForProvider(fakeClient, "rocky", setCache)
  expect(result).toBe(sample)
  expect(cache.rocky).toBe(sample)
})
