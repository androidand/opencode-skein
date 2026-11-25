# Design: model-launch-settings-surface

## D1. Plugin-first, with one honest exception

The goal behind `sustainable-upstream-sync` is that skein-specific features stop
costing a rebase. So the default location for this work is a TUI feature plugin,
registered the way the existing sidebar plugins are (`packages/tui/src/feature-plugins/`,
listed in `builtins.ts`), using only the plugin API:

| Need | Plugin API available today |
| --- | --- |
| A section in the per-model dialog | `TuiDialogStack` (dialogs) |
| Sidebar failure/warning indicator | sidebar slots (`sidebar_content`) |
| Open the dialog from the keyboard | `api.keymap.registerLayer({ commands, bindings })` |
| Talk to llama-skein | `client`, plus the generated llama-skein SDK already in the tree |
| **Add a CLI subcommand** | **none** |

The last row is the exception. `opencode models config` has to be a yargs command,
and the plugin API has no hook for that. Options considered:

1. **A thin core subcommand** (about thirty lines) that calls the same module the
   plugin uses. The rebase cost is one `.command(...)` line next to `ModelsCommand`
   in `packages/opencode/src/index.ts`. *Chosen for now.*
2. **Add a `cli.command` hook to the plugin API** and ship the CLI from the plugin.
   Cleaner, but it is a change to upstream-shaped surface and belongs in the
   plugin-extraction plan, not here. Recorded as an Open Question for it.
3. **No CLI; use the HTTP route.** Rejected: agents and scripts are the people this
   is for, and they use the CLI.

All logic (reading config, building a patch, rendering warnings, rollback) lives in
one module with no UI imports so the dialog, the CLI and tests share it.

## D2. Preview, then apply, with the same code path

A dry run is the host's `PATCH /api/models/config/{id}?dry_run=true`. The dialog and
the CLI both: read current values, build the patch, dry-run it, render the resulting
command and warnings, and only then send the real PATCH. The CLI's `--dry-run` stops
after the preview. Because both paths use one module, a CLI preview can never differ
from what the dialog would show.

## D3. Failure state comes from the host, not from opencode's guess

opencode does not infer that a launch failed from request errors. It reads the host's
model failure state (`model-failure-state`) and shows its reason text and
`suggested_rollback_ref`. Until the host provides them, the section shows nothing
rather than a client-side guess.

## D4. Rollback is a user action with a named blast radius

Rollback replaces the host's whole config with an earlier snapshot, which can undo
unrelated edits made by someone else. The confirmation therefore lists what the
snapshot changes (the snapshot summary from `GET /api/config/history`) and the
reload cost, and the default focus is "Cancel".

## D5. Degrading

`launch-settings`, `config-history` and `dry-run` are detected independently from the
host's capabilities. Missing any one hides only its own control. There is no version
number comparison.

## Open Questions

- Does the plugin-extraction plan intend a `cli.command` plugin hook? If yes, D1
  option 2 supersedes option 1 and the core subcommand should not ship.
- Should the dialog edit the advertised `reasoning` capability and launch
  `thinking_mode` as one control? They are different fields on the host and can
  contradict; the first cut shows both and surfaces the host's contradiction warning.
