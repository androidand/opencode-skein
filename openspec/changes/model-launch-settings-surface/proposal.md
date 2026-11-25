# Change a local model's launch settings from opencode, safely

> **Labels.** This repo is public, so hosts and models are named by capability and
> shape. Host A is a 32 GB RDNA4 workstation serving a 27B hybrid-attention model
> (`M1`) through llama-skein. The mapping lives in the private companion repo.

## Why

On host A, `M1` could not be used for agent work for most of an evening, and every
cause was a launch setting that opencode could not show, validate, or change:

1. The model's command contained a flag spelt a way the engine rejects. It exited
   at startup on every attempt; opencode printed
   `Internal Server Error ... [retrying in 2s attempt #2]` and retried.
2. After that was fixed, tool calls came back as literal text. The model's GGUF
   embedded a template with no tools support, so the model was never shown the
   tools. The first hypothesis (a 1.15 repeat penalty) was only part of it.
3. Thinking had been switched off for the model because the other models on the
   host were configured that way, not because anyone chose it.

Fixing each meant a hand edit of a long command line on the host, a config reload
that stops every loaded model, and reading a service log. The one launch setting
opencode can change is `ctx_size` (`DialogModelCtx`, reached by clicking Context).
`per-model-placement-controls` extends that dialog to `n_gpu_layers`. Nothing
surfaces the rest, and nothing shows when a launch is failing or why.

llama-skein already has the server half of a safe editor — config history,
rollback, a validate dry-run, a failure state — and is gaining the rest (see
Related). opencode uses almost none of it.

## What Changes

- **A Launch section in the per-model dialog**, beside Context and Placement
  (`per-model-placement-controls` D1: one per-model dialog, sections not new
  dialogs). It shows and edits: chat template file, thinking mode (on/off/auto),
  sampling defaults (temperature, top-p, top-k, min-p, repeat penalty), and the
  output limit.
- **Preview before apply.** Every edit first asks the host for a dry run and shows
  the resulting command line and every warning (`launch_flag_unknown`,
  `template_lacks_tools`, `repeat_penalty_may_break_tools`,
  `reasoning_advert_contradicts_launch`). Applying is a second, explicit step that
  names the cost ("this reloads the host and stops loaded models"), reusing the
  reload-cost wording the Context dialog already uses.
- **Failure is visible and recoverable.** When the host reports a model's launch
  has failed, the dialog and the model picker show the host's reason (the engine's
  own message, e.g. an unrecognised flag) and, if the host supplies
  `suggested_rollback_ref`, a one-step "Revert to the previous config" with a
  confirmation naming what changes. opencode never rolls back on its own.
- **A CLI for the same operations.** `opencode models config <provider/model>`
  with `--show`, `--set key=value`, `--unset key`, `--dry-run`, `--history`,
  `--rollback <ref>` and `--json`, so an agent or script can do what the dialog
  does, with identical previews and warnings.
- **Degrades against older hosts.** Each capability is detected from the host
  (`/api/skein/capabilities` and the presence of the fields); against a host that
  predates it, the corresponding control is hidden, never shown broken.

## Capabilities

### New Capabilities

- `model-launch-settings-surface`: the Launch section, preview-then-apply,
  failure/rollback display, and the `models config` CLI.

## Where this lives (plugin-first)

This must not add to the rebase surface of core. See `design.md`: the dialog
section, the picker annotations and all llama-skein calls live in a TUI feature
plugin; the only core change is a thin CLI subcommand, because the plugin API has no
hook for adding one.

## Non-goals

- No editing of the raw `cmd` line in the first cut. Structured fields only; raw
  edit stays a host-side action.
- No model-card defaults, presets or "recommended settings" database.
- No automatic rollback or silent retry changes. The host decides, the user chooses.
- No change to hosts that are not llama-skein.

## Related

- llama-skein (private companion): `fix-crash-loop-start-failures`,
  `add-launch-flag-preflight`, `warn-tool-less-template`,
  `add-model-launch-settings-fields` (server side of everything above),
  `add-config-safety-net`, `model-failure-state`, `add-model-capability-discovery`.
- `per-model-placement-controls` — owns the per-model dialog this extends; this
  change must land its Launch section as a sibling of its Placement section, and
  must not re-decide D1.
- `map-reasoning-capability` — the read side of thinking (whether to render the
  reasoning stream); this change is the write side (whether the model thinks).
- `sustainable-upstream-sync` — the plugin-extraction plan this has to fit.
