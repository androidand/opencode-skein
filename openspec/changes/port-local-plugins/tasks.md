# Tasks: port local/ to plugins

Depends on `plugin-repo-layout` 0.1–0.2 (isolation proof) for anything TUI-exposed.

- [ ] 1.1 Move mDNS/LAN discovery and the llama-skein client into `skein-local`; keep
      contract-first rules (AGENTS.md): OpenAPI is source of truth, `gen/` never
      hand-edited, regenerated via `bun run build:llama-skein-client`.
- [ ] 1.2 Register the provider/model domain surfaces via `rpc.register`; record the RPC
      flavour choice in design.md and hold it (R-P5).
- [ ] 1.3 Re-point `test/local/` + `test/server/` locally-owned cases at the plugin
      package boundary; delete nothing silently — each dropped case is listed with why.
- [ ] 1.4 Add the §11.4 placement regressions (model-ID verification in warm-peer
      routing; idle-sorting policy; reuse context fits; no double-counted capacity).
- [ ] 1.5 Port the 6 TUI dialogs as TUI-plugin routes with the debug-render guard
      (trap 8) and location-aware RPC (trap 7); promote `tui-drive.py` into the CI kit.
- [ ] 1.6 Live smoke (K11): one model-invoked tool execution with real credentials,
      recorded with the transcript and the model/host used.
- [ ] 1.7 Mark fork-side `src/local/` disposition (delete in P1.7 if nothing upstream
      needs it; otherwise list retained delta in `00-current-state.md`).
