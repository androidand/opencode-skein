import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { makeManagedRuntime } from "@/effect/managed-runtime"
import { lazy } from "@/util/lazy"

class Counter extends Context.Service<Counter, { readonly value: number }>()("@test/Counter") {}

const layerWith = (value: number) => Layer.succeed(Counter, { value })

describe("makeManagedRuntime", () => {
  test("disposing an unbuilt runtime is a no-op", async () => {
    const rt = makeManagedRuntime(layerWith(0))
    expect(rt.peek()).toBeUndefined()
    await rt.dispose()
    expect(rt.peek()).toBeUndefined()
  })

  test("disposing rebuilds on next access", async () => {
    const rt = makeManagedRuntime(layerWith(7))
    const first = rt()
    const value = await first.runPromise(
      Effect.gen(function* () {
        return (yield* Counter).value
      }),
    )
    expect(value).toBe(7)

    await rt.dispose()
    expect(rt.peek()).toBeUndefined()

    const second = rt()
    expect(second).not.toBe(first)
    expect(rt.peek()).toBe(second)
    await rt.dispose()
  })

  test("dispose() does not clobber a runtime that was rebuilt mid-dispose", async () => {
    // Simulates a race where dispose() ran on instance A, then someone
    // invoked the lazy and got a fresh instance B before dispose() returned.
    // The resetIf guard must leave instance B intact.
    const rt = makeManagedRuntime(layerWith(1))
    const first = rt()
    rt.reset() // force-eject the lazy
    const second = rt() // build a new instance, distinct from first
    expect(second).not.toBe(first)

    // Calling dispose() now should tear down `second` (the current value),
    // not the orphaned `first`.
    await rt.dispose()
    expect(rt.peek()).toBeUndefined()
  })
})

describe("lazy.resetIf", () => {
  test("resets when the value matches", () => {
    const factory = lazy(() => ({}))
    const value = factory()
    expect(factory.peek()).toBe(value)
    factory.resetIf(value)
    expect(factory.peek()).toBeUndefined()
  })

  test("leaves the lazy intact when the value does not match", () => {
    const factory = lazy(() => ({}))
    const captured = factory()
    factory.reset()
    const fresh = factory()
    expect(fresh).not.toBe(captured)
    factory.resetIf(captured)
    expect(factory.peek()).toBe(fresh)
  })

  test("is a no-op on an unloaded lazy", () => {
    const factory = lazy(() => ({}))
    factory.resetIf({} as never)
    expect(factory.peek()).toBeUndefined()
  })
})
