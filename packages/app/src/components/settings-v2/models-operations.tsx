import { type Component } from "solid-js"
import { useLanguage } from "@/context/language"

/**
 * "Operations" — model-gallery-ui epic section (design.md decision 7:
 * "active and recent host operations"). Genuinely empty for now: wiring this
 * to real data needs a per-provider llama-skein operation client the app
 * side doesn't have yet (task 7.2 — submit/observe/cancel/reconnect by ID).
 * An honest empty state, not a fabricated one, until that lands.
 */
export const SettingsModelsOperationsV2: Component = () => {
  const language = useLanguage()

  return (
    <div class="settings-v2-models">
      <div class="settings-v2-models-status">{language.t("settings.models.operations.empty")}</div>
    </div>
  )
}
