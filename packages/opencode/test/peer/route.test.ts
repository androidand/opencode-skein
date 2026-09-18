import { describe, expect, test } from "bun:test"
import { opencodeSenderOf, OPENCODE_FROM_PREFIX } from "../../src/peer/route"

describe("opencodeSenderOf", () => {
  test("reads the session id out of an opencode envelope address", () => {
    expect(opencodeSenderOf(`${OPENCODE_FROM_PREFIX}ses_abc`)).toBe("ses_abc")
  })
  test("anything else is not an opencode sender", () => {
    expect(opencodeSenderOf("uds:/tmp/cc-socks/123.sock")).toBeUndefined()
    expect(opencodeSenderOf(undefined)).toBeUndefined()
    expect(opencodeSenderOf(OPENCODE_FROM_PREFIX)).toBeUndefined()
  })
})
