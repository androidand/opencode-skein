# Plugin architecture

This is a working note for reorganizing plugin code while the codebase migrates to Effect.

## Current shape

The main problem is that one conceptual system is split across a few large modules with overlapping responsibilities.

```mermaid
flowchart TD
  A[ConfigPlugin origins] --> B[plugin/shared.ts]
  A --> C[plugin/loader.ts]
  A --> D[plugin/install.ts]

  B --> C
  B --> E[plugin/index.ts server runtime]
  B --> F[tui/plugin/runtime.ts TUI runtime]
  B --> D

  C --> E
  C --> F

  D --> G[cli/cmd/plug.ts]
  D --> F

  H[plugin/meta.ts] --> F

  I[npm/index.ts] --> B
  I --> C
  I --> D

  style B fill:#3a2f1f,stroke:#c98a2b,color:#fff
  style C fill:#3a2f1f,stroke:#c98a2b,color:#fff
  style D fill:#3a2f1f,stroke:#c98a2b,color:#fff
  style E fill:#4a1f1f,stroke:#d46a6a,color:#fff
  style F fill:#4a1f1f,stroke:#d46a6a,color:#fff
```

### What is mixed together today

- `src/plugin/shared.ts`
  spec parsing, package reading, entry resolution, compatibility checks, theme discovery, module validation, id resolution
- `src/plugin/loader.ts`
  plan building, target resolution, import, retry rules, reporting hooks
- `src/plugin/install.ts`
  install wrapper, manifest inspection, config patching, file locking
- `src/plugin/index.ts`
  server plugin runtime, hook loading, config fanout, event subscription
- `src/cli/cmd/tui/plugin/runtime.ts`
  TUI runtime state, loading, activation, API adaptation, theme sync, install flow, pending state, process singleton
- `src/plugin/meta.ts`
  file-backed mutable plugin metadata store

## Target shape

The redesign should split stateless plugin plumbing from stateful runtimes.

```mermaid
flowchart TD
  subgraph Pure[Pure helpers]
    S1[plugin/spec.ts]
    S2[plugin/module.ts]
    S3[plugin/manifest.ts]
  end

  subgraph Effects[Effect functions]
    E1[plugin/package.ts]
    E2[plugin/external.ts]
    E3[plugin/install.ts]
    T2[tui/plugin/theme.ts]
    T3[tui/plugin/api.ts]
    T4[tui/plugin/scope.ts]
    T5[tui/plugin/activation.ts]
  end

  subgraph Services[Effect services]
    SV1[plugin/meta-store.ts PluginMetaStore.Service]
    SV2[plugin/server.ts PluginServer.Service]
    SV3[tui/plugin/manager.ts TuiPluginManager.Service]
  end

  Cfg[ConfigPlugin Origins] --> S1
  S1 --> E1
  S1 --> E2
  S2 --> E2
  S3 --> E3
  E1 --> E2
  E1 --> E3
  E2 --> SV2
  E2 --> SV3
  T2 --> SV3
  T3 --> SV3
  T4 --> SV3
  T5 --> SV3
  SV1 --> SV3
  E3 --> CLI[cli/cmd/plug.ts]
  E3 --> SV3

  style Pure fill:#1f3a2a,stroke:#4fa06b,color:#fff
  style Effects fill:#1f2f4a,stroke:#5c8fda,color:#fff
  style Services fill:#3b1f4a,stroke:#b070d6,color:#fff
```

## Module boundaries

### Pure helpers

- `src/plugin/spec.ts`
  parse specifiers, detect npm vs file, normalize ids
- `src/plugin/module.ts`
  validate exported module shape, extract `id`, read v1 server or TUI modules
- `src/plugin/manifest.ts`
  derive package capabilities from package metadata

These should not touch the filesystem or global state.

### Effect functions

- `src/plugin/package.ts`
  read `package.json`, check compatibility, read theme files
- `src/plugin/external.ts`
  resolve targets, resolve entrypoints, import modules, retry local file plugins after dependency prep
- `src/plugin/install.ts`
  shared install and config-patch workflow used by CLI and TUI
- `src/cli/cmd/tui/plugin/theme.ts`
  sync and persist themes
- `src/cli/cmd/tui/plugin/api.ts`
  adapt host API to plugin API
- `src/cli/cmd/tui/plugin/scope.ts`
  lifecycle resource helpers
- `src/cli/cmd/tui/plugin/activation.ts`
  activate and deactivate one plugin entry

These are composable functions that return `Effect`, but do not own long-lived mutable state.

### Services

- `PluginMetaStore.Service`
  owns the metadata file and lock-backed updates
- `PluginServer.Service`
  owns loaded server hooks and bus subscription state per project/worktree via `InstanceState`
- `TuiPluginManager.Service`
  owns loaded TUI entries, enabled state, pending installs, and activation lifecycle

## Runtime split

### Server side

```mermaid
flowchart LR
  A[PluginServer.Service] --> B[build plugin input]
  A --> C[load internal plugins]
  A --> D[load external plugins]
  D --> E[plugin/external.ts]
  A --> F[notify config]
  A --> G[subscribe bus events]
```

### TUI side

```mermaid
flowchart LR
  A[TuiPluginManager.Service] --> B[load internal entries]
  A --> C[load external entries]
  C --> D[plugin/external.ts]
  A --> E[track plugin metadata]
  E --> F[PluginMetaStore.Service]
  A --> G[activate and deactivate]
  G --> H[tui/plugin/activation.ts]
  A --> I[sync themes]
  I --> J[tui/plugin/theme.ts]
  A --> K[install and configure plugin]
  K --> L[plugin/install.ts]
```

## Design rules

- Keep orchestration readable at the top level.
- Put state in services, not module globals.
- Prefer typed results over callback-driven reporting.
- Share install/configure workflow between CLI and TUI.
- Keep plugin discovery parallel, but keep activation and hook registration sequential.
- Preserve the special cases that already matter:
  theme-only TUI plugins, legacy server plugins, local file-plugin retry after dependency prep.

## Suggested migration order

1. Split `shared.ts` into `spec.ts`, `module.ts`, `manifest.ts`, and `package.ts` without changing behavior.
2. Replace `loader.ts` with flat exports in `external.ts` and return typed result values instead of report callbacks.
3. Collapse duplicated install flow into one shared `plugin/install.ts` workflow used by CLI and TUI.
4. Convert `meta.ts` into `PluginMetaStore.Service`.
5. Shrink `plugin/index.ts` into a thin `PluginServer.Service` composition root.
6. Break up `tui/plugin/runtime.ts` and move its mutable runtime state into `TuiPluginManager.Service`.
