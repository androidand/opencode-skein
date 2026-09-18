import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { GalleryHostInventory, GalleryInstalledModel } from "@opencode-ai/sdk/v2/client"
import { createResource, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import {
  canCopy,
  canManage,
  copyTargets,
  deleteAffects,
  errorMessage,
  formatBytes,
  storePeers,
  unwrap,
} from "./models-gallery"

const POLL_MS = 5000

type Pending = { key: string; action: "load" | "unload" }

export const SettingsModelsHostsV2: Component<{ onOperation?: () => void }> = (props) => {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const dialog = useDialog()
  const [pending, setPending] = createSignal<Pending>()

  const [inventories, { refetch }] = createResource(async () => {
    const result = await serverSDK().client.gallery.installed()
    return unwrap(result, language.t("settings.models.hosts.loadError"))
  })

  onMount(() => {
    const timer = setInterval(() => void refetch(), POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  const refresh = async () => {
    await refetch()
    await serverSync()
      .refreshProviders()
      .catch(() => undefined)
  }

  const toggleLoad = async (host: GalleryHostInventory, model: GalleryInstalledModel) => {
    const action = model.loaded ? "unload" : "load"
    setPending({ key: `${host.hostId}:${model.id}`, action })
    try {
      const ref = { galleryModelRef: { hostId: host.hostId, modelId: model.id } }
      const result = action === "load" ? await serverSDK().client.gallery.load(ref) : await serverSDK().client.gallery.unload(ref)
      unwrap(result, language.t("common.requestFailed"))
      await refresh()
    } catch (error) {
      showToast({
        title: language.t(
          action === "load" ? "settings.models.hosts.loadError.title" : "settings.models.hosts.unloadError.title",
        ),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
    } finally {
      setPending(undefined)
    }
  }

  const remove = (host: GalleryHostInventory, model: GalleryInstalledModel) => {
    const affected = deleteAffects(inventories.latest ?? [], host, model.id)
    void dialog.show(() => <DialogRemoveModel host={host} model={model} affected={affected} onDone={refresh} />)
  }

  const copy = (host: GalleryHostInventory, model: GalleryInstalledModel, move: boolean) => {
    const targets = copyTargets(inventories.latest ?? [], host, model.id)
    void dialog.show(() => (
      <DialogCopyModel
        host={host}
        model={model}
        move={move}
        targets={targets}
        onDone={async () => {
          await refresh()
          props.onOperation?.()
        }}
      />
    ))
  }

  return (
    <div class="settings-v2-models-hosts" data-component="settings-models-hosts">
      <Show
        when={inventories.latest !== undefined || !inventories.loading}
        fallback={
          <div class="settings-v2-models-status">
            {language.t("common.loading")}
            {language.t("common.loading.ellipsis")}
          </div>
        }
      >
        <Show
          when={!(inventories.error && inventories.latest === undefined)}
          fallback={
            <div class="settings-v2-models-status" data-error="">
              {errorMessage(inventories.error, language.t("settings.models.hosts.loadError"))}
            </div>
          }
        >
          <For each={inventories.latest ?? []}>
            {(host) => {
              const peers = () => storePeers(inventories.latest ?? [], host)
              return (
                <div class="settings-v2-section" data-component="settings-models-host" data-host={host.hostId}>
                  <h3 class="settings-v2-models-host-header">
                    <span class="settings-v2-section-title">{host.hostName}</span>
                    <Tag variant={host.online ? "accent" : "neutral"}>
                      {host.online
                        ? language.t("settings.models.discover.hostOnline")
                        : language.t("settings.models.discover.hostOffline")}
                    </Tag>
                    <Show when={peers().length > 0}>
                      <Tag title={host.storeKey}>
                        {language.t("settings.models.hosts.sharesStore", {
                          hosts: peers()
                            .map((peer) => peer.hostName)
                            .join(", "),
                        })}
                      </Tag>
                    </Show>
                  </h3>
                  <SettingsListV2>
                    <Show
                      when={host.models.length > 0}
                      fallback={
                        <div class="settings-v2-models-host-empty">{language.t("settings.models.hosts.empty")}</div>
                      }
                    >
                      <For each={host.models}>
                        {(model) => (
                          <ModelRow
                            host={host}
                            model={model}
                            pending={pending()?.key === `${host.hostId}:${model.id}` ? pending()?.action : undefined}
                            onToggleLoad={() => void toggleLoad(host, model)}
                            onRemove={() => remove(host, model)}
                            onCopy={() => copy(host, model, false)}
                            onMove={() => copy(host, model, true)}
                          />
                        )}
                      </For>
                    </Show>
                  </SettingsListV2>
                </div>
              )
            }}
          </For>
        </Show>
      </Show>
    </div>
  )
}

const ModelRow: Component<{
  host: GalleryHostInventory
  model: GalleryInstalledModel
  pending: "load" | "unload" | undefined
  onToggleLoad: () => void
  onRemove: () => void
  onCopy: () => void
  onMove: () => void
}> = (props) => {
  const language = useLanguage()
  const manageable = () => canManage(props.host, props.model) && !props.pending
  const copyable = () => manageable() && canCopy(props.model)
  const copyReason = () => {
    if (!props.model.sourceRepository) return language.t("settings.models.hosts.noSource")
    if (props.model.activeOperationId) return language.t("settings.models.hosts.busy")
    return undefined
  }
  const meta = () =>
    [props.model.quantization, props.model.parameterSize, formatBytes(props.model.sizeBytes)]
      .filter(Boolean)
      .join(" · ")

  return (
    <SettingsRowV2
      title={
        <span class="settings-v2-models-row-title">
          <span>{props.model.id}</span>
          <Show when={props.model.loaded}>
            <Tag variant="accent">{language.t("settings.models.hosts.loaded")}</Tag>
          </Show>
          <Show when={props.model.default}>
            <Tag>{language.t("settings.models.hosts.default")}</Tag>
          </Show>
          <Show when={props.model.activeOperationId}>
            <Tag>{language.t("settings.models.hosts.busy")}</Tag>
          </Show>
        </span>
      }
      description={
        <span class="settings-v2-models-meta">
          <span>{meta()}</span>
          <Show when={props.model.state}>
            <span>{props.model.state}</span>
          </Show>
          <Show when={props.model.sourceRepository}>
            <span>{props.model.sourceRepository}</span>
          </Show>
        </span>
      }
    >
      <div class="settings-v2-models-host-actions">
        <ButtonV2 size="small" variant="ghost-muted" disabled={!manageable()} onClick={props.onToggleLoad}>
          {props.pending === "load"
            ? language.t("settings.models.hosts.loading")
            : props.pending === "unload"
              ? language.t("settings.models.hosts.unloading")
              : props.model.loaded
                ? language.t("settings.models.hosts.unload")
                : language.t("settings.models.hosts.load")}
        </ButtonV2>
        <ButtonV2 size="small" variant="ghost-muted" disabled={!copyable()} title={copyReason()} onClick={props.onCopy}>
          {language.t("settings.models.hosts.copy")}
        </ButtonV2>
        <ButtonV2 size="small" variant="ghost-muted" disabled={!copyable()} title={copyReason()} onClick={props.onMove}>
          {language.t("settings.models.hosts.move")}
        </ButtonV2>
        <ButtonV2 size="small" variant="ghost-muted" disabled={!manageable()} onClick={props.onRemove}>
          {language.t("settings.models.hosts.remove")}
        </ButtonV2>
      </div>
    </SettingsRowV2>
  )
}

const Choice: Component<{
  selected: boolean
  disabled?: boolean
  title: string
  description: string
  warning?: string
  onSelect: () => void
}> = (props) => (
  <button
    type="button"
    class="settings-v2-models-choice"
    role="radio"
    aria-checked={props.selected}
    data-selected={props.selected ? "" : undefined}
    disabled={props.disabled}
    onClick={props.onSelect}
  >
    <span class="settings-v2-models-choice-copy">
      <span class="settings-v2-models-choice-title">{props.title}</span>
      <span class="settings-v2-models-choice-description">{props.description}</span>
      <Show when={props.warning}>
        <span class="settings-v2-models-choice-warning">{props.warning}</span>
      </Show>
    </span>
  </button>
)

const DialogRemoveModel: Component<{
  host: GalleryHostInventory
  model: GalleryInstalledModel
  affected: GalleryHostInventory[]
  onDone: () => Promise<void>
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [mode, setMode] = createSignal<"hide" | "delete">("hide")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const confirm = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await serverSDK().client.gallery.remove({
        galleryRemovePayload: { hostId: props.host.hostId, modelId: props.model.id, mode: mode() },
      })
      const removed = unwrap(result, language.t("settings.models.hosts.remove.error"))
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title:
          removed.mode === "delete"
            ? language.t("settings.models.hosts.remove.done.delete", {
                model: props.model.id,
                count: removed.deletedFiles.length,
              })
            : language.t("settings.models.hosts.remove.done.hide", { model: props.model.id, host: props.host.hostName }),
      })
      await props.onDone()
    } catch (err) {
      setError(errorMessage(err, language.t("settings.models.hosts.remove.error")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>
          {language.t("settings.models.hosts.remove.title", { model: props.model.id, host: props.host.hostName })}
        </DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="settings-v2-models-plan" role="radiogroup">
          <p class="settings-v2-models-hint">{language.t("settings.models.hosts.remove.description")}</p>
          <Choice
            selected={mode() === "hide"}
            disabled={busy()}
            title={language.t("settings.models.hosts.remove.hide")}
            description={language.t("settings.models.hosts.remove.hideDescription")}
            onSelect={() => setMode("hide")}
          />
          <Choice
            selected={mode() === "delete"}
            disabled={busy()}
            title={language.t("settings.models.hosts.remove.delete")}
            description={language.t("settings.models.hosts.remove.deleteDescription", {
              size: formatBytes(props.model.sizeBytes),
            })}
            warning={
              props.affected.length > 0
                ? language.t("settings.models.hosts.remove.deleteWarning", {
                    hosts: props.affected.map((h) => h.hostName).join(", "),
                  })
                : undefined
            }
            onSelect={() => setMode("delete")}
          />
          <Show when={error()}>
            <span class="settings-v2-server-dialog-error">{error()}</span>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant={mode() === "delete" ? "danger" : "contrast"} disabled={busy()} onClick={() => void confirm()}>
          {busy()
            ? language.t("settings.models.hosts.remove.working")
            : mode() === "delete"
              ? language.t("settings.models.hosts.remove.confirmDelete")
              : language.t("settings.models.hosts.remove.confirmHide")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

const DialogCopyModel: Component<{
  host: GalleryHostInventory
  model: GalleryInstalledModel
  move: boolean
  targets: ReturnType<typeof copyTargets<GalleryHostInventory>>
  onDone: () => Promise<void>
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [target, setTarget] = createSignal<string | undefined>(props.targets.find((t) => t.enabled)?.host.hostId)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const confirm = async () => {
    const toHostId = target()
    if (!toHostId) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await serverSDK().client.gallery.copy({
        galleryCopyPayload: { fromHostId: props.host.hostId, toHostId, modelId: props.model.id, move: props.move },
      })
      const copied = unwrap(result, language.t("settings.models.hosts.copy.error"))
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t(props.move ? "settings.models.hosts.move.queued.title" : "settings.models.hosts.copy.queued.title"),
        description: language.t("settings.models.hosts.copy.queued.description", {
          model: props.model.id,
          host: copied.operation.hostName,
        }),
      })
      await props.onDone()
    } catch (err) {
      setError(errorMessage(err, language.t("settings.models.hosts.copy.error")))
    } finally {
      setBusy(false)
    }
  }

  const targetNote = (entry: (typeof props.targets)[number]) => {
    if (!entry.host.online) return language.t("settings.models.hosts.copy.offline")
    if (entry.hasModel) return language.t("settings.models.hosts.copy.alreadyInstalled")
    return entry.shared
      ? language.t("settings.models.hosts.copy.registrationOnly")
      : language.t("settings.models.hosts.copy.download")
  }

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>
          {language.t(props.move ? "settings.models.hosts.move.title" : "settings.models.hosts.copy.title", {
            model: props.model.id,
          })}
        </DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="settings-v2-models-plan" role="radiogroup" aria-label={language.t("settings.models.hosts.copy.target")}>
          <p class="settings-v2-models-hint">
            {props.move
              ? language.t("settings.models.hosts.move.description", { host: props.host.hostName })
              : language.t("settings.models.hosts.copy.description", {
                  source: `${props.model.sourceRepository}@${props.model.sourceRevision.slice(0, 12)}`,
                })}
          </p>
          <Show
            when={props.targets.length > 0}
            fallback={<p class="settings-v2-models-hint">{language.t("settings.models.hosts.copy.noTargets")}</p>}
          >
            <For each={props.targets}>
              {(entry) => (
                <Choice
                  selected={target() === entry.host.hostId}
                  disabled={busy() || !entry.enabled}
                  title={entry.host.hostName}
                  description={targetNote(entry)}
                  onSelect={() => setTarget(entry.host.hostId)}
                />
              )}
            </For>
          </Show>
          <Show when={error()}>
            <span class="settings-v2-server-dialog-error">{error()}</span>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={busy() || !target()} onClick={() => void confirm()}>
          {busy()
            ? language.t("settings.models.hosts.copy.working")
            : language.t(props.move ? "settings.models.hosts.move.confirm" : "settings.models.hosts.copy.confirm")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
