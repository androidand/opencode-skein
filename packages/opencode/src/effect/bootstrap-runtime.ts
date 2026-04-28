import { Layer, ManagedRuntime } from "effect"

import { Plugin } from "@/plugin"
import { LSP } from "@/lsp/lsp"
import { FileWatcher } from "@/file/watcher"
import { Format } from "@/format"
import { ShareNext } from "@/share/share-next"
import { File } from "@/file"
import { Vcs } from "@/project/vcs"
import { Snapshot } from "@/snapshot"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { lazy } from "@/util/lazy"
import * as Observability from "@opencode-ai/core/effect/observability"
import { memoMap } from "@opencode-ai/core/effect/memo-map"

export const BootstrapLayer = Layer.mergeAll(
  Config.defaultLayer,
  Plugin.defaultLayer,
  ShareNext.defaultLayer,
  Format.defaultLayer,
  LSP.defaultLayer,
  File.defaultLayer,
  FileWatcher.defaultLayer,
  Vcs.defaultLayer,
  Snapshot.defaultLayer,
  Bus.defaultLayer,
).pipe(Layer.provide(Observability.layer))

const rt = lazy(() => ManagedRuntime.make(BootstrapLayer, { memoMap }))
type Runtime = Pick<ReturnType<typeof rt>, "runPromise" | "dispose">

export const BootstrapRuntime: Runtime = {
  runPromise(effect, options) {
    return rt().runPromise(effect, options)
  },
  async dispose() {
    const current = rt.peek()
    if (!current) return
    try {
      await current.dispose()
    } finally {
      if (rt.peek() === current) rt.reset()
    }
  },
}
