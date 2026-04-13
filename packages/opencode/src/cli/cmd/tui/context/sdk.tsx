import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent, Event } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup, onMount } from "solid-js"
import { Log } from "@/util/log"
import { errorData } from "@/util/error"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined
    const log = Log.Default.clone().tag("service", "tui-sdk")

    const raw = props.fetch ?? fetch

    const traced: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init)
      const start = Date.now()
      try {
        const res = await raw(req)
        const url = new URL(res.url || req.url)
        if (!res.ok || url.searchParams.get("workspace")) {
          const body = await res
            .clone()
            .text()
            .catch(() => "")
          log.info("sdk fetch", {
            method: req.method,
            request: req.url,
            response: res.url || req.url,
            status: res.status,
            duration: Date.now() - start,
            workspace: url.searchParams.get("workspace"),
            body: body.slice(0, 1000),
          })
        }
        return res
      } catch (error) {
        log.error("sdk fetch failed", {
          method: req.method,
          request: req.url,
          duration: Date.now() - start,
          error: errorData(error),
        })
        throw error
      }
    }

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: traced,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const emitter = createGlobalEmitter<{
      event: GlobalEvent
    }>()

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit("event", event)
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break
          const events = await sdk.global.event({ signal: ctrl.signal })

          for await (const event of events.stream) {
            if (ctrl.signal.aborted) break
            handleEvent(event)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
        }
      })().catch(() => {})
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(handleEvent)
        onCleanup(unsub)
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
    })

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      fetch: traced,
      url: props.url,
    }
  },
})
