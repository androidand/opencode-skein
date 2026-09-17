import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { addIgnored, getIgnored, removeIgnored } from "../../src/local/ignored"

let home: string | undefined
let tmpDir: string

beforeEach(async () => {
  home = process.env.OPENCODE_TEST_HOME
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-ignored-"))
  process.env.OPENCODE_TEST_HOME = tmpDir
})

afterEach(async () => {
  process.env.OPENCODE_TEST_HOME = home
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("local ignored providers", () => {
  test("starts empty", async () => {
    expect(await getIgnored()).toEqual(new Set())
  })

  test("addIgnored persists a normalized baseURL", async () => {
    await addIgnored("HTTP://Host.local:11435/V1/")
    expect(await getIgnored()).toEqual(new Set(["http://host.local:11435/v1"]))
  })

  test("removeIgnored clears a previously ignored baseURL", async () => {
    await addIgnored("http://host.local:11435/v1")
    await removeIgnored("http://host.local:11435/v1/")
    expect(await getIgnored()).toEqual(new Set())
  })

  test("removeIgnored on an entry that was never ignored is a no-op", async () => {
    await removeIgnored("http://never-added.local:11435/v1")
    expect(await getIgnored()).toEqual(new Set())
  })
})
