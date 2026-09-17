# Make /disconnect of a local provider stick

## Why

`syncLocalProviders` re-adds anything it finds on mDNS that is not in config, with no way to
tell "never configured" from "the user just disconnected this". So `/disconnect`'s config
write was silently undone by the very next scan — including the dispose+bootstrap the TUI
dialog triggers right after disconnecting. The provider reappeared before the user ever saw
it gone.

## What Changes

- `packages/opencode/src/local/ignored.ts`: a `local-ignored.json` list of base URLs the user
  explicitly disconnected. `/disconnect` adds the host; `/connect` removes it so reconnecting
  resumes normal auto-heal (IP updates, etc).
- `packages/opencode/src/local/sync.ts`: the add/update/remove decision is extracted as
  `reconcileProviders`, a pure function over a config snapshot and a scan result, and skips
  ignored hosts. It is the code that rewrites and deletes entries in the user's global config,
  so it is now unit-tested rather than only exercised through IO.
- `handlers/local.ts`: connect/disconnect maintain the ignore list.

## Impact

- New: `src/local/ignored.ts`, `test/local/ignored.test.ts`, `test/local/sync.test.ts`.
- Modified: `src/local/sync.ts`, `httpapi/handlers/local.ts`.
