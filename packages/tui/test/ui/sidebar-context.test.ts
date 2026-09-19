import { createEffect, createSignal, on } from "solid-js"
import { describe, expect, test } from "bun:test"

// Verifies the string-equality memo contract that the sidebar VRAM poll
// (sidebar/context.tsx) depends on. `hardwareKey` returns
// `${baseURL}|${modelID}` and the poll effect subscribes via `on(hardwareKey,
// ...)`; `on` compares the memo's value with `!==`, so a memo returning the
// SAME primitive string does NOT re-run the effect (stream ticks that don't
// change model/host must not restart the poll), while a DIFFERENT string does.
//
// This pins the SolidJS framework guarantee the requirement is built on, using
// the same `createSignal` + `on(signal, fn)` + `createEffect` structure the
// sidebar uses.

function mountEffect() {
  const runs: Array<string | null> = []
  const [value, setValue] = createSignal<string | null>(null)
  // Mirror sidebar/context.tsx: `on(signal, (key) => {...})`.
  createEffect(on(value, (key) => {
    runs.push(key)
  }))
  return { value, setValue, runs }
}

describe("ui.sidebar-context.poll key string-equality memo contract", () => {
  test("identical string value does not re-run the poll (stream tick is a no-op)", () => {
    const { setValue, runs } = mountEffect()
    const key = "http://host-a|qwen3:0.5b"
    setValue(key)
    expect(runs).toEqual([null, key])
    setValue(key) // same baseURL + modelID again — e.g. many stream ticks
    expect(runs).toEqual([null, key]) // no additional run
  })

  test("changed modelID re-runs the poll (switch model on one host)", () => {
    const { setValue, runs } = mountEffect()
    setValue("http://host-a|qwen3:0.5b")
    // Same provider, different model — the host+model key changes.
    setValue("http://host-a|qwen3:4b")
    expect(runs).toEqual([null, "http://host-a|qwen3:0.5b", "http://host-a|qwen3:4b"])
  })

  test("changed baseURL re-runs the poll (switch provider)", () => {
    const { setValue, runs } = mountEffect()
    setValue("http://host-a|qwen3:0.5b")
    setValue("http://host-b|llama3:8b")
    expect(runs).toEqual([null, "http://host-a|qwen3:0.5b", "http://host-b|llama3:8b"])
  })

  test("staying null does not re-run the poll (no host)", () => {
    const { setValue, runs } = mountEffect()
    setValue(null)
    expect(runs).toEqual([null]) // initial seed only
  })
})
