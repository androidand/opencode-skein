# plug

Type-only sketch for a cleaner plugin architecture.

This folder is intentionally not wired into the application yet.
It exists so the shape of a redesign is easy to inspect without mixing design work with runtime changes.

## Files

- `common.ts`
  shared helper types used by the rest of the sketch
- `spec.ts`
  plugin declaration and normalization types
- `package.ts`
  package metadata and capability inspection types
- `module.ts`
  imported module shape and validation types
- `external.ts`
  external plugin load pipeline types
- `meta.ts`
  plugin metadata store types
- `install.ts`
  install and config patch workflow types
- `server.ts`
  server plugin service types
- `tui.ts`
  TUI plugin manager service types

## Reading order

If you want the sketch to build up from small concepts to runtime orchestration, read the files in this order:

1. `spec.ts`
   Start here for the basic nouns: plugin kinds, sources, declarations, config origins, and normalized candidates.
2. `package.ts`
   Next read how package metadata is described after a plugin target has been resolved.
3. `module.ts`
   Then read the imported module shapes and validation results for v1 and legacy modules.
4. `external.ts`
   This is the shared external loading pipeline that connects spec parsing, package inspection, and module import.
5. `meta.ts`
   Read this next to see what state should be persisted across runs and why it belongs behind a service.
6. `install.ts`
   This describes the install, manifest, and config patch workflow shared by CLI and TUI.
7. `server.ts`
   Read the server runtime service after the lower-level pipeline files, since it mainly composes those pieces.
8. `tui.ts`
   Read this last because it has the largest runtime surface and depends on most of the earlier concepts.
9. `common.ts`
   This file is only shared utility typing. You can skim it first or ignore it until you see a helper type you want to expand.

## Intent

- Stateful parts are described as service interfaces.
- Stateless parts are described as function types returning `Effect`.
- The comments explain what each type is for and where it would sit in the architecture.
