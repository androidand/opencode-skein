import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { createSignal, startTransition, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { SettingsModelsInstalledV2 } from "./models-installed"
import { SettingsModelsDiscoverV2 } from "./models-discover"
import { SettingsModelsOperationsV2 } from "./models-operations"
import "./settings-v2.css"

/**
 * V2 Model Settings, extended with the model-gallery-ui epic's three
 * sections (design.md decision 7):
 *
 *   Installed    current discovered models and host/runtime state
 *   Discover     curated/live gallery
 *   Operations   active and recent host operations
 */
type ModelsTab = "installed" | "discover" | "operations"

export const SettingsModelsV2: Component = () => {
  const language = useLanguage()
  const [tab, setTab] = createSignal<ModelsTab>("installed")

  return (
    <TabsV2 value={tab()} onChange={(value) => void startTransition(() => setTab(value as ModelsTab))}>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.models.title")}</h2>
        <TabsV2.List>
          <TabsV2.Trigger value="installed">{language.t("settings.models.installed")}</TabsV2.Trigger>
          <TabsV2.Trigger value="discover">{language.t("settings.models.discover")}</TabsV2.Trigger>
          <TabsV2.Trigger value="operations">{language.t("settings.models.operations")}</TabsV2.Trigger>
        </TabsV2.List>
      </div>
      <div class="settings-v2-tab-body">
        <TabsV2.Content value="installed">
          <SettingsModelsInstalledV2 onOperation={() => void startTransition(() => setTab("operations"))} />
        </TabsV2.Content>
        <TabsV2.Content value="discover">
          <SettingsModelsDiscoverV2 onInstalled={() => void startTransition(() => setTab("operations"))} />
        </TabsV2.Content>
        <TabsV2.Content value="operations">
          <SettingsModelsOperationsV2 />
        </TabsV2.Content>
      </div>
    </TabsV2>
  )
}
