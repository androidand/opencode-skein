// Smoke test: verifies the generated LlamaSkeinClient can exercise the
// model-operation API surface (list/create/get/cancel) against a local
// mock server. This is the local stand-in for task 7.5's "smoke-test one
// CUDA/ROCm host and one Apple unified-memory host from opencode-skein
// without Skein running" — it validates the client contracts without
// requiring remote hardware.
//
// The real hardware smoke test (one ROCm host, one Apple unified-memory host) still
// requires SSH access to those hosts; this test covers the client-side
// integration path that those hardware tests would exercise.
import { describe, expect, test } from "bun:test"
import { createClient, createConfig } from "../../src/local/llama-skein/gen/client"
import { LlamaSkeinClient } from "../../src/local/llama-skein/gen/sdk.gen"
import type { ModelOperation, ModelInstallPlan } from "../../src/local/llama-skein/gen/types.gen"

// ---------------------------------------------------------------------------
// Minimal mock server that answers the operation API endpoints.
// ---------------------------------------------------------------------------

function makeMockServer() {
  const operations = new Map<string, ModelOperation>()
  let nextId = 0

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const path = url.pathname

    if (req.method === "GET" && path === "/api/models/operations") {
      const ops = Array.from(operations.values()).sort(
        (a, b) => b.created_at.localeCompare(a.created_at),
      )
      return Response.json({ operations: ops })
    }

    if (req.method === "POST" && path === "/api/models/operations") {
      const body = (await req.json()) as ModelInstallPlan
      const id = `op_${++nextId}`
      const now = new Date().toISOString()
      const op: ModelOperation = {
        id,
        phase: "queued",
        model_id: body.registration?.model_id ?? null,
        artifacts: (body.artifacts ?? []).map((a) => ({
          path: a.path,
          bytes_total: a.size_bytes ?? null,
          bytes_downloaded: 0,
        })),
        bytes_downloaded: 0,
        bytes_total: body.artifacts?.reduce((s, a) => s + (a.size_bytes ?? 0), 0),
        created_at: `${now}.${nextId}`,
        updated_at: `${now}.${nextId}`,
      }
      operations.set(id, op)
      return Response.json(op, { status: 201 })
    }

    const opMatch = path.match(/^\/api\/models\/operations\/([^/]+)$/)
    const cancelMatch = path.match(/^\/api\/models\/operations\/([^/]+)\/cancel$/)
    if (req.method === "GET" && opMatch) {
      const op = operations.get(opMatch[1])
      if (!op) return Response.json({ error: "not found" }, { status: 404 })
      return Response.json(op)
    }

    if (req.method === "POST" && cancelMatch) {
      const op = operations.get(cancelMatch[1])
      if (!op) return Response.json({ error: "not found" }, { status: 404 })
      // Idempotent cancel: just return current state.
      return Response.json(op)
    }

    return Response.json({ error: "not found" }, { status: 404 })
  }

  return { handler, operations }
}

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

function makeClient(baseUrl: string) {
  return new LlamaSkeinClient({
    client: createClient(createConfig({ baseUrl })),
  })
}

async function withMockServer(fn: (baseUrl: string) => Promise<void>) {
  const { handler, operations } = makeMockServer()
  const server = Bun.serve({
    port: 0,
    fetch: handler,
  })
  try {
    await fn(`http://localhost:${server.port}`)
  } finally {
    server.stop(true)
  }
  return { operations }
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("llama-skein client smoke (operation API)", () => {
  test("listModelOperations returns empty list initially", async () => {
    await withMockServer(async (baseUrl) => {
      const client = makeClient(baseUrl)
      const res = await client.listModelOperations()
      expect(res.error).toBeUndefined()
      expect(res.data?.operations).toEqual([])
    })
  })

  test("createModelOperation returns 201 with queued phase", async () => {
    await withMockServer(async (baseUrl) => {
      const client = makeClient(baseUrl)
      const plan: ModelInstallPlan = {
        source_repository: "test/model",
        source_revision: "abc123",
        artifacts: [
          { path: "model.gguf", size_bytes: 1_000_000_000, digest: "sha256:test", role: "weights" },
        ],
        registration: {
          backend: "llamacpp",
          model_id: "test-model",
          capabilities: ["completion"],
        },
      }
      const res = await client.createModelOperation({ body: plan })
      expect(res.error).toBeUndefined()
      expect(res.data?.phase).toBe("queued")
      expect(res.data?.model_id).toBe("test-model")
      expect(res.data?.bytes_total).toBe(1_000_000_000)
    })
  })

  test("getModelOperation returns the created operation", async () => {
    await withMockServer(async (baseUrl) => {
      const client = makeClient(baseUrl)
      const plan: ModelInstallPlan = {
        source_repository: "test/model",
        source_revision: "abc123",
        artifacts: [
          { path: "model.gguf", size_bytes: 500_000_000, digest: "sha256:test", role: "weights" },
        ],
        registration: {
          backend: "llamacpp",
          model_id: "my-model",
          capabilities: ["completion"],
        },
      }
      const createRes = await client.createModelOperation({ body: plan })
      expect(createRes.error).toBeUndefined()
      const opId = createRes.data!.id

      const getRes = await client.getModelOperation({ path: { id: opId } })
      expect(getRes.error).toBeUndefined()
      expect(getRes.data?.id).toBe(opId)
      expect(getRes.data?.phase).toBe("queued")
    })
  })

  test("cancelModelOperation is idempotent", async () => {
    await withMockServer(async (baseUrl) => {
      const client = makeClient(baseUrl)
      const plan: ModelInstallPlan = {
        source_repository: "test/model",
        source_revision: "abc123",
        artifacts: [
          { path: "model.gguf", size_bytes: 200_000_000, digest: "sha256:test", role: "weights" },
        ],
        registration: {
          backend: "llamacpp",
          model_id: "cancel-test",
          capabilities: ["completion"],
        },
      }
      const createRes = await client.createModelOperation({ body: plan })
      expect(createRes.error).toBeUndefined()
      const opId = createRes.data!.id

      // First cancel.
      const cancel1 = await client.cancelModelOperation({ path: { id: opId } })
      expect(cancel1.error).toBeUndefined()
      expect(cancel1.data?.id).toBe(opId)

      // Second cancel — idempotent.
      const cancel2 = await client.cancelModelOperation({ path: { id: opId } })
      expect(cancel2.error).toBeUndefined()
      expect(cancel2.data?.id).toBe(opId)
    })
  })

  test("getModelOperation returns 404 for unknown id", async () => {
    await withMockServer(async (baseUrl) => {
      const client = makeClient(baseUrl)
      const res = await client.getModelOperation({ path: { id: "nonexistent" } })
      expect(res.error).toBeDefined()
    })
  })

  test("listModelOperations returns operations newest first", async () => {
    await withMockServer(async (baseUrl) => {
      const client = makeClient(baseUrl)
      const plans: ModelInstallPlan[] = [
        {
          source_repository: "test/a",
          source_revision: "aaa",
          artifacts: [{ path: "a.gguf", size_bytes: 100, digest: "sha256:a", role: "weights" }],
          registration: { backend: "llamacpp", model_id: "model-a", capabilities: [] },
        },
        {
          source_repository: "test/b",
          source_revision: "bbb",
          artifacts: [{ path: "b.gguf", size_bytes: 200, digest: "sha256:b", role: "weights" }],
          registration: { backend: "llamacpp", model_id: "model-b", capabilities: [] },
        },
      ]
      for (const plan of plans) {
        const res = await client.createModelOperation({ body: plan })
        expect(res.error).toBeUndefined()
      }

      const listRes = await client.listModelOperations()
      expect(listRes.error).toBeUndefined()
      expect(listRes.data?.operations).toHaveLength(2)
      // Newest first (created later = sorted first).
      expect(listRes.data!.operations![0]!.model_id).toBe("model-b")
      expect(listRes.data!.operations![1]!.model_id).toBe("model-a")
    })
  })
})
