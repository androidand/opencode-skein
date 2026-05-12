import { Flag } from "@/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { onMount } from "solid-js"
import { useLocal } from "./context/local"
import { usePromptRef } from "./context/prompt"
import { useRoute } from "./context/route"
import { useSync } from "./context/sync"
import { useToast } from "./ui/toast"

const model = {
  providerID: "mock",
  modelID: "mock-model",
}

function parse(raw: string) {
  try {
    const json = JSON.parse(raw)
    return Array.isArray(json) ? json : []
  } catch {
    return []
  }
}

async function load() {
  if (Flag.OPENCODE_TUI_RUNNER_FILE) {
    return parse(await Filesystem.readText(Flag.OPENCODE_TUI_RUNNER_FILE).catch(() => "[]"))
  }

  return parse(Flag.OPENCODE_TUI_RUNNER_STEPS ?? "[]")
}

function text(step: unknown) {
  return typeof step === "string" ? step : JSON.stringify(step)
}

async function wait<T>(test: () => T | false | undefined, timeout = 30_000) {
  const start = Date.now()

  while (Date.now() - start < timeout) {
    const value = test()
    if (value) return value
    await Bun.sleep(100)
  }

  throw new Error("Mock runner timed out")
}

export function Mock() {
  const local = useLocal()
  const prompt = usePromptRef()
  const route = useRoute()
  const sync = useSync()
  const toast = useToast()

  onMount(() => {
    if (Flag.OPENCODE_TUI_RUNNER !== "mock") return

    void (async () => {
      const steps = await load()
      if (!steps.length) {
        toast.show({
          message: "Mock runner has no steps",
          variant: "warning",
          duration: 3000,
        })
        return
      }

      await wait(() => sync.ready && local.model.ready)
      await wait(() => !!sync.data.provider.find((item) => item.id === model.providerID)?.models[model.modelID])
      local.model.set(model, { recent: true })

      for (const step of steps) {
        await wait(() => !!prompt.current)
        local.model.set(model)

        const prev = route.data.type === "session" ? route.data.sessionID : undefined
        const count = prev ? sync.data.message[prev]?.length ?? 0 : 0

        prompt.current!.set({
          input: text(step),
          parts: [],
        })
        prompt.current!.submit()

        const sid = await wait(() => (route.data.type === "session" ? route.data.sessionID : undefined))
        await wait(() => {
          const list = sync.data.message[sid] ?? []
          if (list.length <= (sid === prev ? count : 0)) return false
          return sync.session.status(sid) === "idle" && list.at(-1)?.role !== "user"
        }, 120000)
      }

      toast.show({
        message: `Mock runner sent ${steps.length} prompt(s)`,
        variant: "success",
        duration: 3000,
      })
    })().catch((err) => {
      toast.show({
        message: err instanceof Error ? err.message : "Mock runner failed",
        variant: "error",
        duration: 5000,
      })
    })
  })

  return <></>
}
