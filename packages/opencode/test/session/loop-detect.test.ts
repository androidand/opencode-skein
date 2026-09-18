import { describe, expect, test } from "bun:test"
import { LoopDetect } from "@/session/loop-detect"

describe("loop-detect.toolCallSignature", () => {
  test("returns undefined for no tool calls", () => {
    expect(LoopDetect.toolCallSignature([])).toBeUndefined()
  })

  test("is identical for the same tool and arguments", () => {
    const a = LoopDetect.toolCallSignature([{ tool: "send_peer_message", input: { target: "x", message: "hi" } }])
    const b = LoopDetect.toolCallSignature([{ tool: "send_peer_message", input: { target: "x", message: "hi" } }])
    expect(a).toBe(b)
  })

  test("is identical regardless of argument key order", () => {
    const a = LoopDetect.toolCallSignature([{ tool: "ha_get_state", input: { entity_id: "x", verbose: true } }])
    const b = LoopDetect.toolCallSignature([{ tool: "ha_get_state", input: { verbose: true, entity_id: "x" } }])
    expect(a).toBe(b)
  })

  test("differs when arguments differ", () => {
    const a = LoopDetect.toolCallSignature([{ tool: "ha_get_state", input: { entity_id: "a" } }])
    const b = LoopDetect.toolCallSignature([{ tool: "ha_get_state", input: { entity_id: "b" } }])
    expect(a).not.toBe(b)
  })

  test("differs when the tool differs", () => {
    const a = LoopDetect.toolCallSignature([{ tool: "read", input: { path: "x" } }])
    const b = LoopDetect.toolCallSignature([{ tool: "write", input: { path: "x" } }])
    expect(a).not.toBe(b)
  })

  test("differs when the number of calls in the turn differs", () => {
    const one = LoopDetect.toolCallSignature([{ tool: "read", input: { path: "x" } }])
    const two = LoopDetect.toolCallSignature([
      { tool: "read", input: { path: "x" } },
      { tool: "read", input: { path: "x" } },
    ])
    expect(one).not.toBe(two)
  })
})

describe("loop-detect.detectRepeat", () => {
  const threshold = 0.92

  test("no previous turn is never a repeat", () => {
    expect(LoopDetect.detectRepeat({ text: "hello", toolSignature: undefined }, undefined, threshold)).toEqual({
      repeated: false,
    })
  })

  test("repeats the same tool call with the same arguments", () => {
    const sig = LoopDetect.toolCallSignature([
      { tool: "send_peer_message", input: { target: "ses_x", message: "hi" } },
    ])
    const turn = { text: "", toolSignature: sig }
    const result = LoopDetect.detectRepeat(turn, turn, threshold)
    expect(result).toEqual({ repeated: true, kind: "tool" })
  })

  test("does not flag the same tool with different arguments", () => {
    const last = {
      text: "",
      toolSignature: LoopDetect.toolCallSignature([{ tool: "send_peer_message", input: { target: "ses_a" } }]),
    }
    const current = {
      text: "",
      toolSignature: LoopDetect.toolCallSignature([{ tool: "send_peer_message", input: { target: "ses_b" } }]),
    }
    expect(LoopDetect.detectRepeat(current, last, threshold)).toEqual({ repeated: false })
  })

  test("flags near-identical text with no tool calls", () => {
    const last = { text: "Thinking about the next step...", toolSignature: undefined }
    const current = { text: "Thinking about the next step..", toolSignature: undefined }
    const result = LoopDetect.detectRepeat(current, last, threshold)
    expect(result.repeated).toBe(true)
    if (result.repeated) expect(result.kind).toBe("text")
  })

  test("does not flag dissimilar text with no tool calls", () => {
    const last = { text: "Reading the config file now.", toolSignature: undefined }
    const current = { text: "Running the test suite.", toolSignature: undefined }
    expect(LoopDetect.detectRepeat(current, last, threshold)).toEqual({ repeated: false })
  })

  test("switching from a tool call to plain text is not a repeat, in either direction", () => {
    const toolTurn = {
      text: "",
      toolSignature: LoopDetect.toolCallSignature([{ tool: "read", input: { path: "x" } }]),
    }
    const textTurn = { text: "Let me check that file.", toolSignature: undefined }
    expect(LoopDetect.detectRepeat(textTurn, toolTurn, threshold)).toEqual({ repeated: false })
    expect(LoopDetect.detectRepeat(toolTurn, textTurn, threshold)).toEqual({ repeated: false })
  })
})
