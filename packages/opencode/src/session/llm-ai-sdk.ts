import { ContentBlockID, FinishReason, LLMEvent, ProviderMetadata, ToolCallID, ToolResultValue, Usage } from "@opencode-ai/llm"
import { Effect, Schema } from "effect"
import { type streamText } from "ai"
import { errorMessage } from "@/util/error"

type Result = Awaited<ReturnType<typeof streamText>>
type AISDKEvent = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

export function adapterState() {
  return {
    step: 0,
    text: 0,
    reasoning: 0,
    currentTextID: undefined as ContentBlockID | undefined,
    currentReasoningID: undefined as ContentBlockID | undefined,
    toolNames: {} as Record<string, string>,
  }
}

const contentBlockID = (value: string) => ContentBlockID.make(value)
const toolCallID = (value: string) => ToolCallID.make(value)

function finishReason(value: string | undefined): FinishReason {
  return Schema.is(FinishReason)(value) ? value : "unknown"
}

function providerMetadata(value: unknown): ProviderMetadata | undefined {
  return Schema.is(ProviderMetadata)(value) ? value : undefined
}

function usage(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object") return undefined
  const item = value as {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
    outputTokenDetails?: { reasoningTokens?: number }
  }
  const result = Object.fromEntries(
    Object.entries({
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      totalTokens: item.totalTokens,
      reasoningTokens: item.outputTokenDetails?.reasoningTokens ?? item.reasoningTokens,
      cacheReadInputTokens: item.inputTokenDetails?.cacheReadTokens ?? item.cachedInputTokens,
      cacheWriteInputTokens: item.inputTokenDetails?.cacheWriteTokens,
    }).filter((entry) => entry[1] !== undefined),
  )
  return new Usage(result)
}

export function toLLMEvents(
  state: ReturnType<typeof adapterState>,
  event: AISDKEvent,
): Effect.Effect<ReadonlyArray<LLMEvent>, unknown> {
  switch (event.type) {
    case "start":
      return Effect.succeed([])

    case "start-step":
      return Effect.succeed([LLMEvent.stepStart({ index: state.step })])

    case "finish-step":
      return Effect.sync(() => [
        LLMEvent.stepFinish({
          index: state.step++,
          reason: finishReason(event.finishReason),
          usage: usage(event.usage),
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "finish":
      return Effect.sync(() => {
        state.toolNames = {}
        return [
          LLMEvent.requestFinish({
            reason: finishReason(event.finishReason),
            usage: usage(event.totalUsage),
          }),
        ]
      })

    case "text-start":
      return Effect.sync(() => {
        state.currentTextID = contentBlockID(event.id ?? `text-${state.text++}`)
        return [
          LLMEvent.textStart({
            id: state.currentTextID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "text-delta":
      return Effect.succeed([
        LLMEvent.textDelta({
          id: event.id ? contentBlockID(event.id) : (state.currentTextID ?? contentBlockID(`text-${state.text++}`)),
          text: event.text,
        }),
      ])

    case "text-end":
      return Effect.succeed([
        LLMEvent.textEnd({
          id: event.id ? contentBlockID(event.id) : (state.currentTextID ?? contentBlockID(`text-${state.text++}`)),
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "reasoning-start":
      return Effect.sync(() => {
        state.currentReasoningID = contentBlockID(event.id)
        return [
          LLMEvent.reasoningStart({
            id: state.currentReasoningID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-delta":
      return Effect.succeed([
        LLMEvent.reasoningDelta({
          id: event.id ? contentBlockID(event.id) : (state.currentReasoningID ?? contentBlockID(`reasoning-${state.reasoning++}`)),
          text: event.text,
        }),
      ])

    case "reasoning-end":
      return Effect.sync(() => {
        const id = contentBlockID(event.id)
        state.currentReasoningID = undefined
        return [
          LLMEvent.reasoningEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-start":
      return Effect.sync(() => {
        state.toolNames[event.id] = event.toolName
        return [
          LLMEvent.toolInputStart({
            id: toolCallID(event.id),
            name: event.toolName,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-delta":
      return Effect.succeed([
        LLMEvent.toolInputDelta({
          id: toolCallID(event.id),
          name: state.toolNames[event.id] ?? "unknown",
          text: event.delta ?? "",
        }),
      ])

    case "tool-input-end":
      return Effect.succeed([
        LLMEvent.toolInputEnd({
          id: toolCallID(event.id),
          name: state.toolNames[event.id] ?? "unknown",
        }),
      ])

    case "tool-call":
      return Effect.sync(() => {
        state.toolNames[event.toolCallId] = event.toolName
        return [
          LLMEvent.toolCall({
            id: toolCallID(event.toolCallId),
            name: event.toolName,
            input: event.input,
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-result":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? "unknown"
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolResult({
            id: toolCallID(event.toolCallId),
            name,
            result: ToolResultValue.make(event.output),
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
          }),
        ]
      })

    case "tool-error":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? "unknown"
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolError({
            id: toolCallID(event.toolCallId),
            name,
            message: errorMessage(event.error),
          }),
        ]
      })

    case "error":
      return Effect.fail(event.error)

    default:
      return Effect.succeed([])
  }
}

export * as LLMAISDK from "./llm-ai-sdk"
