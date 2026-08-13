import { createResource, For, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

/**
 * "Discover" — model-gallery-ui epic section (design.md decision 7:
 * "curated/live gallery"). This first slice is deliberately narrow: it lists
 * the llama-skein hosts the already-shipped `GET /gallery/hosts` endpoint
 * (model-gallery-ui task 5.7) can see, online/offline and installed-model
 * count, as real proof the gallery backend is reachable from this panel.
 *
 * Candidate search/filters/cards (task 6.2), candidate detail (6.3), and
 * host-comparison evidence (6.4) are NOT built here — this is the section
 * existing, per task 6.1's own scope, not the full Discover experience.
 */
export const SettingsModelsDiscoverV2: Component = () => {
  const language = useLanguage()
  const serverSDK = useServerSDK()

  const [hosts] = createResource(() =>
    serverSDK()
      .client.gallery.hosts()
      .then((result) => result.data ?? [])
      .catch(() => []),
  )

  return (
    <div class="settings-v2-models">
      <Show
        when={!hosts.loading}
        fallback={
          <div class="settings-v2-models-status">
            {language.t("common.loading")}
            {language.t("common.loading.ellipsis")}
          </div>
        }
      >
        <Show
          when={(hosts.latest ?? []).length > 0}
          fallback={<div class="settings-v2-models-status">{language.t("settings.models.discover.empty")}</div>}
        >
          <div class="settings-v2-section" data-component="settings-models-discover-hosts">
            <h3 class="settings-v2-models-group-header">
              <span class="settings-v2-section-title">{language.t("settings.models.discover.hostsTitle")}</span>
            </h3>
            <SettingsListV2>
              <For each={hosts.latest}>
                {(host) => (
                  <SettingsRowV2
                    title={host.name}
                    description={
                      host.online
                        ? language.plural("settings.models.discover.hostInstalledCount", host.installedModelIDs.length)
                        : language.t("settings.models.discover.hostOffline")
                    }
                  >
                    <span
                      class="settings-v2-models-status-filter"
                      data-online={host.online ? "" : undefined}
                      aria-label={
                        host.online
                          ? language.t("settings.models.discover.hostOnline")
                          : language.t("settings.models.discover.hostOffline")
                      }
                    >
                      {host.online
                        ? language.t("settings.models.discover.hostOnline")
                        : language.t("settings.models.discover.hostOffline")}
                    </span>
                  </SettingsRowV2>
                )}
              </For>
            </SettingsListV2>
          </div>
        </Show>
      </Show>
    </div>
  )
}
