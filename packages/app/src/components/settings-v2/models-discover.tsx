import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type {
  GalleryCandidate,
  GalleryEntry,
  GalleryInstallPayload,
  GalleryInstallPlanView,
  GalleryVariantFit,
} from "@opencode-ai/sdk/v2/client"
import { createResource, createSignal, For, onCleanup, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import {
  canInstall,
  defaultVariant,
  errorMessage,
  formatBytes,
  formatContext,
  formatCount,
  formatMegabytes,
  formatParams,
  num,
  repositoryUrl,
  unwrap,
  variantFor,
} from "./models-gallery"

const SEARCH_DEBOUNCE_MS = 350
const SEARCH_LIMIT = "30"

export const SettingsModelsDiscoverV2: Component<{ onInstalled?: () => void }> = (props) => {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const dialog = useDialog()

  const [input, setInput] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<GalleryCandidate>()
  const [planning, setPlanning] = createSignal<string>()
  const [variantChoice, setVariantChoice] = createStore<Record<string, string | undefined>>({})

  let timer: ReturnType<typeof setTimeout> | undefined
  const search = (value: string) => {
    setInput(value)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => setQuery(value.trim()), SEARCH_DEBOUNCE_MS)
  }
  const clear = () => {
    if (timer) clearTimeout(timer)
    setInput("")
    setQuery("")
    setSelected(undefined)
  }
  onCleanup(() => timer && clearTimeout(timer))

  const [hosts] = createResource(() =>
    serverSDK()
      .client.gallery.hosts()
      .then((result) => result.data ?? [])
      .catch(() => []),
  )

  const [results] = createResource(query, async (q) => {
    if (!q) return [] as GalleryCandidate[]
    const result = await serverSDK().client.gallery.search({ q, limit: SEARCH_LIMIT })
    return unwrap(result, language.t("settings.models.discover.search.error"))
  })

  const [entries] = createResource(
    () => selected()?.id,
    async (candidateId) => {
      const result = await serverSDK().client.gallery.evaluate({
        galleryEvaluatePayload: { candidateIds: [candidateId], includeIncompatible: true },
      })
      return unwrap(result, language.t("settings.models.discover.evaluateError"))
    },
  )

  const chosen = (entry: GalleryEntry) => variantFor(entry, variantChoice[entry.hostId]) ?? defaultVariant(entry)

  const install = async (candidate: GalleryCandidate, entry: GalleryEntry) => {
    const variant = chosen(entry)
    const payload: GalleryInstallPayload = {
      hostId: entry.hostId,
      candidateId: candidate.id,
      variantId: variant?.variantName,
    }
    setPlanning(entry.hostId)
    try {
      const result = await serverSDK().client.gallery.plan({ galleryInstallPayload: payload })
      const plan = unwrap(result, language.t("settings.models.discover.install.planError"))
      void dialog.show(() => <DialogInstallPlan plan={plan} payload={payload} onInstalled={props.onInstalled} />)
    } catch (error) {
      showToast({
        title: language.t("settings.models.discover.install.planError"),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
    } finally {
      setPlanning(undefined)
    }
  }

  const status = (message: string, error?: boolean) => (
    <div class="settings-v2-models-status" data-error={error ? "" : undefined}>
      {message}
    </div>
  )

  return (
    <>
      <div class="settings-v2-tab-search">
        <TextInputV2
          type="search"
          appearance="base"
          value={input()}
          onInput={(event) => search(event.currentTarget.value)}
          placeholder={language.t("settings.models.discover.search.placeholder")}
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          aria-label={language.t("settings.models.discover.search.placeholder")}
        />
        <Show when={input()}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            class="settings-v2-tab-search-clear"
            icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
            onClick={clear}
          />
        </Show>
      </div>

      <div class="settings-v2-models" data-component="settings-models-discover">
        <Show
          when={selected()}
          fallback={
            <Show
              when={query()}
              fallback={
                <>
                  <p class="settings-v2-models-hint">{language.t("settings.models.discover.search.hint")}</p>
                  <DiscoverHosts hosts={hosts.latest ?? []} loading={hosts.loading} />
                </>
              }
            >
              <Show
                when={!results.loading}
                fallback={status(language.t("settings.models.discover.search.searching"))}
              >
                <Show
                  when={!results.error}
                  fallback={status(
                    errorMessage(results.error, language.t("settings.models.discover.search.error")),
                    true,
                  )}
                >
                  <Show
                    when={(results.latest ?? []).length > 0}
                    fallback={
                      <div class="settings-v2-models-status">
                        <span>{language.t("settings.models.discover.search.noResults")}</span>
                        <span class="settings-v2-models-status-filter">&quot;{query()}&quot;</span>
                      </div>
                    }
                  >
                    <div class="settings-v2-section" data-component="settings-models-discover-results">
                      <h3 class="settings-v2-models-group-header">
                        <span class="settings-v2-section-title">
                          {language.t("settings.models.discover.resultsTitle")}
                        </span>
                      </h3>
                      <SettingsListV2>
                        <For each={results.latest}>
                          {(candidate) => (
                            <SettingsRowV2
                              title={
                                <span class="settings-v2-models-row-title">
                                  <span>{candidate.name}</span>
                                  <Tag>{candidate.author}</Tag>
                                  <Show when={candidate.freshness === "seed"}>
                                    <Tag variant="accent">{language.t("settings.models.discover.seedBadge")}</Tag>
                                  </Show>
                                </span>
                              }
                              description={<CandidateMeta candidate={candidate} />}
                            >
                              <ButtonV2 size="normal" variant="neutral" onClick={() => setSelected(candidate)}>
                                {language.t("settings.models.discover.details")}
                              </ButtonV2>
                            </SettingsRowV2>
                          )}
                        </For>
                      </SettingsListV2>
                    </div>
                  </Show>
                </Show>
              </Show>
            </Show>
          }
        >
          {(candidate) => (
            <div class="settings-v2-models-detail" data-component="settings-models-discover-detail">
              <div class="settings-v2-models-detail-header">
                <div class="settings-v2-models-detail-heading">
                  <span class="settings-v2-models-row-title">
                    <span class="settings-v2-models-detail-name">{candidate().name}</span>
                    <Tag>{candidate().author}</Tag>
                    <Show when={candidate().freshness === "seed"}>
                      <Tag variant="accent">{language.t("settings.models.discover.seedBadge")}</Tag>
                    </Show>
                  </span>
                  <a
                    class="settings-v2-link"
                    href={repositoryUrl(candidate().repository)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {repositoryUrl(candidate().repository)}
                  </a>
                </div>
                <ButtonV2 size="normal" variant="ghost-muted" onClick={() => setSelected(undefined)}>
                  {language.t("settings.models.discover.back")}
                </ButtonV2>
              </div>

              <CandidateFacts candidate={candidate()} />

              <div class="settings-v2-section" data-component="settings-models-discover-compare">
                <h3 class="settings-v2-models-group-header">
                  <span class="settings-v2-section-title">{language.t("settings.models.discover.hostsCompare")}</span>
                </h3>
                <Show when={!entries.loading} fallback={status(language.t("settings.models.discover.evaluating"))}>
                  <Show
                    when={!entries.error}
                    fallback={status(
                      errorMessage(entries.error, language.t("settings.models.discover.evaluateError")),
                      true,
                    )}
                  >
                    <Show
                      when={(entries.latest ?? []).length > 0}
                      fallback={status(language.t("settings.models.discover.evaluateEmpty"))}
                    >
                      <div class="settings-v2-models-compare-scroll">
                        <table class="settings-v2-models-compare">
                          <thead>
                            <tr>
                              <th>{language.t("settings.models.discover.compare.host")}</th>
                              <th>{language.t("settings.models.discover.compare.status")}</th>
                              <th>{language.t("settings.models.discover.compare.fit")}</th>
                              <th>{language.t("settings.models.discover.compare.context")}</th>
                              <th>{language.t("settings.models.discover.compare.vram")}</th>
                              <th>{language.t("settings.models.discover.compare.variant")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={entries.latest}>
                              {(entry) => (
                                <HostRow
                                  entry={entry}
                                  variant={chosen(entry)}
                                  planning={planning() === entry.hostId}
                                  onVariant={(name) => setVariantChoice(entry.hostId, name)}
                                  onInstall={() => void install(candidate(), entry)}
                                />
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    </Show>
                  </Show>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </div>
    </>
  )
}

const DiscoverHosts: Component<{
  hosts: Array<{ id: string; name: string; online: boolean; installedModelIDs: string[] }>
  loading: boolean
}> = (props) => {
  const language = useLanguage()
  return (
    <Show
      when={!props.loading}
      fallback={
        <div class="settings-v2-models-status">
          {language.t("common.loading")}
          {language.t("common.loading.ellipsis")}
        </div>
      }
    >
      <Show
        when={props.hosts.length > 0}
        fallback={<div class="settings-v2-models-status">{language.t("settings.models.discover.empty")}</div>}
      >
        <div class="settings-v2-section" data-component="settings-models-discover-hosts">
          <h3 class="settings-v2-models-group-header">
            <span class="settings-v2-section-title">{language.t("settings.models.discover.hostsTitle")}</span>
          </h3>
          <SettingsListV2>
            <For each={props.hosts}>
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
  )
}

const CandidateMeta: Component<{ candidate: GalleryCandidate }> = (props) => {
  const language = useLanguage()
  return (
    <span class="settings-v2-models-meta">
      <Show when={formatParams(props.candidate.parameterCount)}>
        {(params) => <span>{params()}</span>}
      </Show>
      <Show when={props.candidate.license}>
        <span>{props.candidate.license}</span>
      </Show>
      <span>
        {language.t("settings.models.discover.downloads", { count: formatCount(props.candidate.downloads) })}
      </span>
      <span>{language.t("settings.models.discover.variantCount", { count: props.candidate.variants.length })}</span>
    </span>
  )
}

const CandidateFacts: Component<{ candidate: GalleryCandidate }> = (props) => {
  const language = useLanguage()
  return (
    <dl class="settings-v2-models-facts">
      <div class="settings-v2-models-fact">
        <dt>{language.t("settings.models.discover.license")}</dt>
        <dd>{props.candidate.license || "—"}</dd>
      </div>
      <div class="settings-v2-models-fact">
        <dt>{language.t("settings.models.discover.parameters")}</dt>
        <dd>{formatParams(props.candidate.parameterCount) || "—"}</dd>
      </div>
      <div class="settings-v2-models-fact">
        <dt>{language.t("settings.models.discover.trainedContext")}</dt>
        <dd>{formatContext(props.candidate.trainedContext) || "—"}</dd>
      </div>
      <div class="settings-v2-models-fact">
        <dt>{language.t("settings.models.discover.pipeline")}</dt>
        <dd>{props.candidate.pipelineTag || "—"}</dd>
      </div>
      <div class="settings-v2-models-fact">
        <dt>{language.t("settings.models.discover.capabilities")}</dt>
        <dd>
          <Show when={props.candidate.capabilities.length > 0} fallback="—">
            <span class="settings-v2-models-chips">
              <For each={props.candidate.capabilities}>{(capability) => <Tag>{capability}</Tag>}</For>
            </span>
          </Show>
        </dd>
      </div>
      <div class="settings-v2-models-fact">
        <dt>{language.t("settings.models.discover.variants")}</dt>
        <dd>
          <Show when={props.candidate.variants.length > 0} fallback="—">
            <span class="settings-v2-models-chips">
              <For each={props.candidate.variants}>
                {(variant) => (
                  <Tag>
                    {variant.quantization || variant.id} · {formatBytes(variant.totalBytes)}
                    <Show when={!variant.complete}>
                      {" · "}
                      {language.t("settings.models.discover.variantIncomplete")}
                    </Show>
                  </Tag>
                )}
              </For>
            </span>
          </Show>
        </dd>
      </div>
    </dl>
  )
}

const HostRow: Component<{
  entry: GalleryEntry
  variant: GalleryVariantFit | undefined
  planning: boolean
  onVariant: (name: string) => void
  onInstall: () => void
}> = (props) => {
  const language = useLanguage()

  const state = () => {
    const entry = props.entry
    if (!entry.online) return language.t("settings.models.discover.hostOffline")
    if (entry.installed) return language.t("settings.models.discover.compare.installed")
    if (entry.busy) return language.t("settings.models.discover.compare.busy")
    return language.t("settings.models.discover.hostOnline")
  }

  const fitLevel = () => (props.entry.fitKnown && props.variant ? props.variant.fitLevel : "")
  const context = () => (props.variant ? formatContext(props.variant.maxFitCtx) : "")
  const vram = () =>
    num(props.entry.vramTotalMB) > 0
      ? `${formatMegabytes(props.entry.vramFreeMB)} / ${formatMegabytes(props.entry.vramTotalMB)}`
      : ""

  return (
    <tr data-component="settings-models-host-row" data-host={props.entry.hostId}>
      <td>
        <div class="settings-v2-models-compare-host">
          <span>{props.entry.hostName}</span>
          <Show when={props.entry.stateDetail}>
            <span class="settings-v2-models-compare-detail">{props.entry.stateDetail}</span>
          </Show>
        </div>
      </td>
      <td>{state()}</td>
      <td>
        <div class="settings-v2-models-compare-host">
          <Show
            when={fitLevel()}
            fallback={<span>{language.t("settings.models.discover.compare.unknown")}</span>}
          >
            {(level) => (
              <span class="settings-v2-models-fit" data-level={level()}>
                {level().replace(/_/g, " ")}
              </span>
            )}
          </Show>
          <Show when={props.variant?.reason}>
            <span class="settings-v2-models-compare-detail">{props.variant?.reason}</span>
          </Show>
          <Show when={props.entry.incompatibleReasons.length > 0}>
            <ul class="settings-v2-models-reasons">
              <For each={props.entry.incompatibleReasons}>{(reason) => <li>{reason}</li>}</For>
            </ul>
          </Show>
        </div>
      </td>
      <td>{context() || "—"}</td>
      <td>{vram() || "—"}</td>
      <td>
        <div class="settings-v2-models-compare-actions">
          <Show when={props.entry.variants.length > 0}>
            <SelectV2
              appearance="inline"
              options={props.entry.variants}
              current={props.variant}
              value={(variant) => variant.variantName}
              label={(variant) => variant.variantName}
              disabled={!props.entry.online}
              onSelect={(variant) => variant && props.onVariant(variant.variantName)}
            />
          </Show>
          <ButtonV2
            size="normal"
            variant="contrast"
            disabled={!canInstall(props.entry) || props.planning}
            onClick={props.onInstall}
          >
            {props.planning
              ? language.t("settings.models.discover.install.planning")
              : language.t("settings.models.discover.install")}
          </ButtonV2>
        </div>
      </td>
    </tr>
  )
}

const DialogInstallPlan: Component<{
  plan: GalleryInstallPlanView
  payload: GalleryInstallPayload
  onInstalled?: () => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const confirm = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await serverSDK().client.gallery.install({ galleryInstallPayload: props.payload })
      const operation = unwrap(result, language.t("settings.models.discover.install.error"))
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.models.discover.install.queued.title"),
        description: language.t("settings.models.discover.install.queued.description", {
          model: operation.modelId || props.plan.modelId,
          host: operation.hostName || props.plan.hostName,
        }),
      })
      props.onInstalled?.()
    } catch (err) {
      setError(errorMessage(err, language.t("settings.models.discover.install.error")))
    } finally {
      setBusy(false)
    }
  }

  const row = (label: string, value: string) => (
    <div class="settings-v2-models-plan-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )

  return (
    <Dialog fit class="settings-v2-server-dialog settings-v2-models-install-plan">
      <DialogHeader hideClose={true}>
        <DialogTitle>{language.t("settings.models.discover.install.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="settings-v2-models-plan">
          <p class="settings-v2-models-hint">{language.t("settings.models.discover.install.description")}</p>
          <dl class="settings-v2-models-plan">
            {row(language.t("settings.models.discover.install.host"), props.plan.hostName)}
            {row(
              language.t("settings.models.discover.install.source"),
              `${props.plan.repository}@${props.plan.revision.slice(0, 12)}`,
            )}
            {row(language.t("settings.models.discover.install.modelId"), props.plan.modelId)}
            {row(language.t("settings.models.discover.install.backend"), props.plan.backend)}
            {row(
              language.t("settings.models.discover.install.size"),
              `${formatBytes(props.plan.bytes)} · ${language.t("settings.models.discover.install.files", { count: props.plan.artifacts.length })}`,
            )}
            {row(language.t("settings.models.discover.license"), props.plan.license || "—")}
          </dl>
          <Show when={error()}>
            <span class="settings-v2-server-dialog-error">{error()}</span>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={busy()} onClick={() => void confirm()}>
          {busy()
            ? language.t("settings.models.discover.install.submitting")
            : language.t("settings.models.discover.install.confirm")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
