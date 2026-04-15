import { Global } from "@/global"
import { AppRuntime } from "@/effect/app-runtime"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Effect } from "effect"
import { createSignal, type Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import path from "path"

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, any>>()
    const filePath = path.join(Global.Path.state, "kv.json")
    const read = () =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          return yield* fs.readJson(filePath)
        }),
      )
    const write = (data: unknown) =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          yield* fs.writeJson(filePath, data)
        }),
      )

    read()
      .then((x) => {
        if (typeof x === "object" && x !== null) setStore(x as Record<string, any>)
      })
      .catch(() => {})
      .finally(() => {
        setReady(true)
      })

    const result = {
      get ready() {
        return ready()
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T) {
        if (store[name] === undefined) setStore(name, defaultValue)
        return [
          function () {
            return result.get(name)
          },
          function setter(next: Setter<T>) {
            result.set(name, next)
          },
        ] as const
      },
      get(key: string, defaultValue?: any) {
        return store[key] ?? defaultValue
      },
      set(key: string, value: any) {
        setStore(key, value)
        write(store)
      },
    }
    return result
  },
})
