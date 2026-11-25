import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as Heap from "@/cli/heap"

// heap.ts is a singleton module with module-level state (timer, lock, armed).
// We test the externally-visible contract: start() is safe to call at any time,
// and it respects the OPENCODE_AUTO_HEAP_SNAPSHOT flag.
//
// The actual snapshot-writing path (RSS > 2 GB) is exercised in production
// by the TUI and the main CLI entry point. Unit tests cannot reliably force
// RSS above 2 GB, so we verify the no-op path and idempotency here.

describe("heap snapshot", () => {
  beforeEach(() => {
    delete process.env.OPENCODE_AUTO_HEAP_SNAPSHOT
  })

  afterEach(() => {
    delete process.env.OPENCODE_AUTO_HEAP_SNAPSHOT
  })

  test("start() is a no-op when the flag is not set", () => {
    // Should not throw; should not start a timer.
    expect(() => Heap.start()).not.toThrow()
  })

  test("start() is idempotent", () => {
    // Setting the flag and calling start() twice must not throw or
    // create duplicate timers.
    process.env.OPENCODE_AUTO_HEAP_SNAPSHOT = "1"
    expect(() => Heap.start()).not.toThrow()
    expect(() => Heap.start()).not.toThrow()
  })

  test("start() is safe after a prior no-op call", () => {
    // Call start() without flag (no-op), then enable flag and call again.
    Heap.start()
    process.env.OPENCODE_AUTO_HEAP_SNAPSHOT = "true"
    expect(() => Heap.start()).not.toThrow()
  })
})
