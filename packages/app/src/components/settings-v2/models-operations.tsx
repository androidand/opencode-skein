import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import type { GalleryOperation } from "@opencode-ai/sdk/v2/client"
import { createResource, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import {
  errorMessage,
  formatBytes,
  isTerminal,
  num,
  progressPercent,
  splitOperations,
  succeededSince,
  unwrap,
} from "./models-gallery"

const POLL_MS = 2000

const PHASE_KEYS = {
  queued: "settings.models.operations.phase.queued",
  preflighting: "settings.models.operations.phase.preflighting",
  resolving: "settings.models.operations.phase.resolving",
  downloading: "settings.models.operations.phase.downloading",
  verifying: "settings.models.operations.phase.verifying",
  installing: "settings.models.operations.phase.installing",
  registering: "settings.models.operations.phase.registering",
  reloading: "settings.models.operations.phase.reloading",
  succeeded: "settings.models.operations.phase.succeeded",
  cancelled: "settings.models.operations.phase.cancelled",
  failed: "settings.models.operations.phase.failed",
} as const

export const SettingsModelsOperationsV2: Component = () => {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [cancelling, setCancelling] = createSignal<string>()

  let previous: GalleryOperation[] | undefined

  const [operations, { refetch }] = createResource(async () => {
    const result = await serverSDK().client.gallery.operations()
    const next = unwrap(result, language.t("settings.models.operations.loadError"))
    if (previous) {
      for (const op of succeededSince(previous, next)) {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.models.operations.succeeded.title"),
          description: language.t("settings.models.operations.succeeded.description", {
            model: op.modelId,
            host: op.hostName,
          }),
        })
      }
      if (succeededSince(previous, next).length > 0) {
        void serverSync()
          .refreshProviders()
          .catch(() => undefined)
      }
    }
    previous = next
    return next
  })

  onMount(() => {
    const timer = setInterval(() => void refetch(), POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  const cancel = async (op: GalleryOperation) => {
    const key = `${op.hostId}:${op.id}`
    setCancelling(key)
    try {
      const result = await serverSDK().client.gallery.cancel({ galleryOperationRef: { hostId: op.hostId, id: op.id } })
      unwrap(result, language.t("settings.models.operations.cancelError"))
      await refetch()
    } catch (error) {
      showToast({
        title: language.t("settings.models.operations.cancelError"),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
    } finally {
      setCancelling(undefined)
    }
  }

  const groups = () => splitOperations(operations.latest ?? [])

  return (
    <div class="settings-v2-models" data-component="settings-models-operations">
      <Show
        when={operations.latest !== undefined || !operations.loading}
        fallback={
          <div class="settings-v2-models-status">
            {language.t("common.loading")}
            {language.t("common.loading.ellipsis")}
          </div>
        }
      >
        <Show
          when={!(operations.error && operations.latest === undefined)}
          fallback={
            <div class="settings-v2-models-status" data-error="">
              {errorMessage(operations.error, language.t("settings.models.operations.loadError"))}
            </div>
          }
        >
          <Show
            when={(operations.latest ?? []).length > 0}
            fallback={
              <div class="settings-v2-models-status">{language.t("settings.models.operations.empty")}</div>
            }
          >
            <Show when={groups().active.length > 0}>
              <OperationGroup
                title={language.t("settings.models.operations.active")}
                operations={groups().active}
                cancelling={cancelling()}
                onCancel={(op) => void cancel(op)}
              />
            </Show>
            <Show when={groups().recent.length > 0}>
              <OperationGroup
                title={language.t("settings.models.operations.recent")}
                operations={groups().recent}
                cancelling={cancelling()}
                onCancel={(op) => void cancel(op)}
              />
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

const OperationGroup: Component<{
  title: string
  operations: GalleryOperation[]
  cancelling: string | undefined
  onCancel: (op: GalleryOperation) => void
}> = (props) => (
  <div class="settings-v2-section" data-component="settings-models-operations-group">
    <h3 class="settings-v2-models-group-header">
      <span class="settings-v2-section-title">{props.title}</span>
    </h3>
    <SettingsListV2>
      <For each={props.operations}>
        {(op) => (
          <OperationRow
            operation={op}
            cancelling={props.cancelling === `${op.hostId}:${op.id}`}
            onCancel={() => props.onCancel(op)}
          />
        )}
      </For>
    </SettingsListV2>
  </div>
)

const OperationRow: Component<{ operation: GalleryOperation; cancelling: boolean; onCancel: () => void }> = (
  props,
) => {
  const language = useLanguage()

  const phase = () => {
    const key = PHASE_KEYS[props.operation.phase as keyof typeof PHASE_KEYS]
    return key ? language.t(key) : props.operation.phase
  }
  const percent = () => progressPercent(props.operation.bytesDownloaded, props.operation.bytesTotal)
  const total = () => num(props.operation.bytesTotal)
  const progressLabel = () =>
    total() > 0
      ? `${percent()}% · ${formatBytes(props.operation.bytesDownloaded)} / ${formatBytes(total())}`
      : formatBytes(props.operation.bytesDownloaded)
  const terminal = () => isTerminal(props.operation.phase)
  const failed = () => props.operation.phase === "failed" && props.operation.error?.message

  return (
    <div
      class="settings-v2-models-operation"
      data-component="settings-models-operation"
      data-phase={props.operation.phase}
    >
      <div class="settings-v2-models-operation-head">
        <div class="settings-v2-models-operation-title">
          <span>{props.operation.hostName}</span>
          <span>{props.operation.modelId}</span>
          <Tag variant={terminal() ? "neutral" : "accent"}>{phase()}</Tag>
        </div>
        <div class="settings-v2-models-operation-actions">
          <Show when={!terminal()}>
            <ButtonV2 size="small" variant="ghost-muted" disabled={props.cancelling} onClick={props.onCancel}>
              {props.cancelling
                ? language.t("settings.models.operations.cancelling")
                : language.t("settings.models.operations.cancel")}
            </ButtonV2>
          </Show>
        </div>
      </div>

      <Show when={total() > 0 || !terminal()}>
        <div class="settings-v2-models-progress" role="progressbar" aria-valuenow={percent()} aria-valuemin={0} aria-valuemax={100}>
          <div class="settings-v2-models-progress-bar">
            <span style={{ width: `${terminal() && props.operation.phase === "succeeded" ? 100 : percent()}%` }} />
          </div>
          <span class="settings-v2-models-progress-label">{progressLabel()}</span>
        </div>
      </Show>

      <Show when={failed()}>
        {(message) => (
          <div class="settings-v2-models-operation-error">
            <Show when={props.operation.error.code}>{props.operation.error.code}: </Show>
            {message()}
          </div>
        )}
      </Show>

      <Show when={props.operation.warnings.length > 0}>
        <ul class="settings-v2-models-operation-warnings" aria-label={language.t("settings.models.operations.warnings")}>
          <For each={props.operation.warnings}>{(warning) => <li>{warning}</li>}</For>
        </ul>
      </Show>

      <Show when={props.operation.artifacts.length > 0}>
        <details class="settings-v2-models-artifacts">
          <summary>
            {language.t("settings.models.operations.artifacts", { count: props.operation.artifacts.length })}
          </summary>
          <For each={props.operation.artifacts}>
            {(artifact) => (
              <div class="settings-v2-models-artifact">
                <span title={artifact.path}>{artifact.path}</span>
                <span class="settings-v2-models-progress-bar">
                  <span style={{ width: `${progressPercent(artifact.bytesDownloaded, artifact.bytesTotal)}%` }} />
                </span>
                <span>
                  {formatBytes(artifact.bytesDownloaded)} / {formatBytes(artifact.bytesTotal)}
                </span>
              </div>
            )}
          </For>
        </details>
      </Show>
    </div>
  )
}
