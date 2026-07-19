import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("OPENCODE_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@opencode/RuntimeFlags", {
  autoShare: bool("OPENCODE_AUTO_SHARE"),
  pure: bool("OPENCODE_PURE"),
  disableDefaultPlugins: bool("OPENCODE_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("OPENCODE_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("OPENCODE_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("OPENCODE_DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("OPENCODE_DISABLE_CLAUDE_CODE"),
    direct: bool("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("OPENCODE_DISABLE_CLAUDE_CODE"),
    direct: bool("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("OPENCODE_ENABLE_EXA"),
    legacy: bool("OPENCODE_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("OPENCODE_ENABLE_PARALLEL"),
    legacy: bool("OPENCODE_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("OPENCODE_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("OPENCODE_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("OPENCODE_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("OPENCODE_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("OPENCODE_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("OPENCODE_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("OPENCODE_EXPERIMENTAL_PLAN_MODE"),
  experimentalEventSystem: enabledByExperimental("OPENCODE_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("OPENCODE_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("OPENCODE_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("OPENCODE_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("OPENCODE_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("OPENCODE_CLIENT").pipe(Config.withDefault("cli")),
  // CLI/TUI feature flags
  showTtfD: bool("OPENCODE_SHOW_TTFD"),
  autoHeapSnapshot: bool("OPENCODE_AUTO_HEAP_SNAPSHOT"),
  alwaysNotifyUpdate: bool("OPENCODE_ALWAYS_NOTIFY_UPDATE"),
  disableAutoupdate: bool("OPENCODE_DISABLE_AUTOUPDATE"),
  disableProjectConfig: bool("OPENCODE_DISABLE_PROJECT_CONFIG"),
  disableAutocompact: bool("OPENCODE_DISABLE_AUTOCOMPACT"),
  disablePrune: bool("OPENCODE_DISABLE_PRUNE"),
  disableTerminalTitle: bool("OPENCODE_DISABLE_TERMINAL_TITLE"),
  disableModelsFetch: bool("OPENCODE_DISABLE_MODELS_FETCH"),
  disableMouse: bool("OPENCODE_DISABLE_MOUSE"),
  // Server/auth
  serverPassword: Config.string("OPENCODE_SERVER_PASSWORD").pipe(Config.option),
  serverUsername: Config.string("OPENCODE_SERVER_USERNAME").pipe(Config.withDefault("opencode")),
  // Config paths
  config: Config.string("OPENCODE_CONFIG").pipe(Config.option),
  configDir: Config.string("OPENCODE_CONFIG_DIR").pipe(Config.option),
  configContent: Config.string("OPENCODE_CONFIG_CONTENT").pipe(Config.option),
  tuiConfig: Config.string("OPENCODE_TUI_CONFIG").pipe(Config.option),
  permission: Config.string("OPENCODE_PERMISSION").pipe(Config.option),
  // Git/tooling
  gitBashPath: Config.string("OPENCODE_GIT_BASH_PATH").pipe(Config.option),
  fakeVcs: Config.string("OPENCODE_FAKE_VCS").pipe(Config.option),
  // Workspace
  workspaceId: Config.string("OPENCODE_WORKSPACE_ID").pipe(Config.option),
  // Plugin
  pluginMetaFile: Config.string("OPENCODE_PLUGIN_META_FILE").pipe(Config.option),
  // Observability
  otlpEndpoint: Config.string("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(Config.option),
  otlpHeaders: Config.string("OTEL_EXPORTER_OTLP_HEADERS").pipe(Config.option),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.defaultLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const defaultLayer = Service.defaultLayer.pipe(Layer.orDie)

export const node = LayerNode.make(defaultLayer, [])

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
