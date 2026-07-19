import { describe, expect, test, beforeEach } from "bun:test"
import * as ctx from "../../src/context"

type User = { id: string; name: string }
type Session = { sessionId: string; userId: string }

describe("context manager", () => {
  beforeEach(() => {
    ctx.reset()
  })

  test("creates a named manager and provides a value", () => {
    const manager = ctx.create<User>("test-user")
    expect(manager.name).toBe("test-user")
    expect(ctx.list()).toContain("test-user")

    let received: User | undefined
    manager.provide({ id: "u1", name: "Alice" }, () => {
      received = manager.use()
    })

    expect(received).toEqual({ id: "u1", name: "Alice" })
  })

  test("use throws NotFound when context is absent", () => {
    const manager = ctx.create<User>("test-user")
    expect(() => manager.use()).toThrow(ctx.NotFound)
  })

  test("tryUse returns undefined when absent", () => {
    const manager = ctx.create<User>("test-user")
    expect(manager.tryUse()).toBeUndefined()
  })

  test("isSet returns false when absent, true when present", () => {
    const manager = ctx.create<User>("test-user")
    expect(manager.isSet()).toBe(false)

    manager.provide({ id: "u1", name: "Alice" }, () => {
      expect(manager.isSet()).toBe(true)
    })
  })

  test("provides isolate context per call (nested calls do not leak)", () => {
    const manager = ctx.create<Session>("test-session")

    manager.provide({ sessionId: "s1", userId: "u1" }, () => {
      expect(manager.use().sessionId).toBe("s1")

      manager.provide({ sessionId: "s2", userId: "u2" }, () => {
        expect(manager.use().sessionId).toBe("s2")
      })

      expect(manager.use().sessionId).toBe("s1")
    })

    expect(manager.tryUse()).toBeUndefined()
  })

  test("creates throws DuplicateNameError on duplicate", () => {
    ctx.create<User>("dup-test")
    expect(() => ctx.create<Session>("dup-test")).toThrow(ctx.DuplicateNameError)
  })

  test("lookup returns the manager by name", () => {
    ctx.create<User>("lookup-test")
    const found = ctx.lookup("lookup-test")
    expect(found).toBeDefined()
    expect(found!.name).toBe("lookup-test")
  })

  test("lookup returns undefined for unknown name", () => {
    expect(ctx.lookup("nonexistent")).toBeUndefined()
  })

  test("reset clears the registry", () => {
    ctx.create<User>("reset-test")
    expect(ctx.list()).toContain("reset-test")
    ctx.reset()
    expect(ctx.list()).not.toContain("reset-test")
  })

  test("backward-compat shim works like legacy create", () => {
    const shim = ctx.LocalContextCompat.create<User>("shim-test")
    shim.provide({ id: "s1", name: "Shim" }, () => {
      expect(shim.use()).toEqual({ id: "s1", name: "Shim" })
    })
  })

  test("registry exposes all registered names", () => {
    ctx.create<User>("r1")
    ctx.create<Session>("r2")
    expect(ctx.list().sort()).toEqual(["r1", "r2"])
  })
})
