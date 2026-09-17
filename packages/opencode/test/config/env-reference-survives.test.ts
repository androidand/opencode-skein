import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

/**
 * A provider write must not burn `{env:}` references onto disk. `getGlobal()`
 * returns the config after substitution, so round-tripping it through
 * `updateGlobal` wrote the resolved secret — or "" when the variable was
 * unset — into the user's config, silently undoing an env-based setup.
 */
describe("provider writes and {env:} references", () => {
  async function configWith(apiKey: string) {
    const dir = await mkdtemp(join(tmpdir(), "ek-envref-"))
    const file = join(dir, "opencode.json")
    await writeFile(
      file,
      JSON.stringify(
        {
          provider: {
            azure: { npm: "@ai-sdk/openai-compatible", options: { apiKey, baseURL: "https://x/v1" } },
            gpuhost1: {
              npm: "@ai-sdk/openai-compatible",
              options: { apiKey: "skein", baseURL: "http://192.0.2.126:11435/v1" },
            },
          },
        },
        null,
        2,
      ),
    )
    return { dir, file }
  }

  test("a raw read keeps the reference; a substituted read does not", async () => {
    const { file } = await configWith("{env:AZURE_API_KEY}")
    const raw = JSON.parse(await readFile(file, "utf8"))
    expect(raw.provider.azure.options.apiKey).toBe("{env:AZURE_API_KEY}")

    // What the old code effectively wrote back: the expanded value.
    process.env["AZURE_API_KEY"] = "real-secret-value"
    const substituted = JSON.parse(
      (await readFile(file, "utf8")).replace(/\{env:([^}]+)\}/g, (_, n) => process.env[n] ?? ""),
    )
    expect(substituted.provider.azure.options.apiKey).toBe("real-secret-value")
    delete process.env["AZURE_API_KEY"]
  })

  test("an unset variable substitutes to empty, which is what broke auth", async () => {
    const { file } = await configWith("{env:AZURE_API_KEY}")
    delete process.env["AZURE_API_KEY"]
    const substituted = JSON.parse(
      (await readFile(file, "utf8")).replace(/\{env:([^}]+)\}/g, (_, n) => process.env[n] ?? ""),
    )
    expect(substituted.provider.azure.options.apiKey).toBe("")
  })

  test("sync's reconcile leaves a hand-written entry's apiKey untouched", async () => {
    const { reconcileProviders } = await import("../../src/local/sync")
    const { providers, changes } = reconcileProviders({
      providers: {
        azure: { npm: "@ai-sdk/openai-compatible", options: { apiKey: "{env:AZURE_API_KEY}" } },
      } as any,
      online: [{ name: "gpuhost1", host: "192.0.2.126", baseURL: "http://192.0.2.126:11435/v1", source: "mdns" }],
      selfIPs: new Set<string>(),
      selfSlug: "gpuhost5",
    })
    expect((providers as any).azure.options.apiKey).toBe("{env:AZURE_API_KEY}")
    expect(changes.some((c) => c.type === "added")).toBe(true)
  })
})
