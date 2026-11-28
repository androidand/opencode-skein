import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000
// A fit-derived `limit.context` already has the reply allowance deducted by the
// host, so only a small buffer is left to hold — enough for the count to be a
// little stale, not enough to re-charge the deduction.
const FIT_DERIVED_BUFFER = 2_048

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    (Provider.isFitDerivedContext(input.model.providerID, input.model.id)
      ? FIT_DERIVED_BUFFER
      : Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax)))
  const inputLimit = input.model.limit.input
  const capacity = inputLimit ? Math.min(inputLimit, context) : context
  return Math.max(0, capacity - reserved)
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  const limit = usable(input)
  if (limit === 0) return false
  return count >= limit
}
