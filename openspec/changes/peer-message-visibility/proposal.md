# Make peer messages visible, and make the peer tools harder to misuse

## Status

Planning. Reviewed 2026-10-12; scope narrowed to what session data proves. No GitHub
issue yet (when created, use specsync with `-repo androidand/opencode-skein`).

## Why

### 1. A received peer message is invisible (proven)

A sent peer message appears in the chat as a `send_peer_message` tool call. A received one
does not appear at all. Checked in the session store: `ses_ecea4460…` stored both messages
`ses_ee838380…` sent (18:36:42 and 18:41:55) and each started an assistant turn. Delivery
works; display does not.

Mechanism: every inbound path (`peer/claude/lifecycle.ts` for the sidecar,
`tool/send-peer-message.ts` `runLocal` for owned sessions, and queued drains through
`PeerInbox`) calls `prompt` with one `{ type: "text", synthetic: true, text }` part. That
creates a user message holding only a synthetic part, which the TUI's `!part.synthetic`
checks treat as not-user-content, so nothing renders.

### 2. Peer tools are misused in ways the data shows (measured)

Across all sessions in `opencode-dev.db` (2,430 `send_peer_message`, 384 `peers` calls):

- **`peers` run as a shell command**: ~40 bash calls in 11 sessions, strong models
  included (`rtk peers`, `peers`, `opencode peers`). Results: `rtk: No such file or
  directory`, `command not found: peers`, and `opencode peers` hanging until killed
  (signal 9 / exit 137). The model learns nothing useful from any of them.
- **Schema errors**: 15 `send_peer_message` calls rejected (`mode` given as the literal
  `"notify"|"request"`, missing `target`).
- **Text-form call**: 1 occurrence (`<invoke name="send_peer_message">` written as
  assistant text, never executed). Too rare to build a feature on.
- **Retry loops on a missing target** (226 calls): all on 2026-09-18, fixed 2026-09-19 by
  `peer-conversation-reliability`; one recurrence since. Not in scope.

## What Changes

1. A dedicated `peer-message` part in the real Part union (`session/message-v2.ts`),
   produced by every inbound path when the envelope parses (`parsePeerEnvelope`, the
   single parser), falling back to synthetic text otherwise.
2. An explicit conversion branch so the model receives the same text as today, plus a
   narrow guard test: every `Part` type is either converted for the model or declared
   UI-only. (`toModelMessages` silently skips unknown types.)
3. Rendering on every surface that renders parts: TUI, web app, session-ui, CLI run mode.
4. `peers` in bash returns a pointer to the `peers` tool instead of a filesystem error.
5. Shorter, example-first descriptions for `send_peer_message` and `peers`, keeping the
   rules that exist because of incidents.

## Out of Scope

- Envelope wire format, sidecar transport, reply correlation (see
  `peer-conversation-reliability`).
- Executing text-form tool calls; any change to the repeat-guard; delivery-result
  wording (queued and not-found results already say not to retry).
- Whether the `peers` tool was in the weak model's toolset: unverified, reported only.
- `packages/tui/src/local/llama-skein/gen/`: generated from the llama-skein OpenAPI
  spec, contains no `Part` types, not affected.
- Claude Code's own UI.

## Impact

- `session/message-v2.ts`, its `toModelMessages`, SDK generation for `Part` (find the
  generator before editing), `peer/claude/lifecycle.ts`, `tool/send-peer-message.ts`,
  `tool/bash` (intercept), tool `.txt` descriptions, and part renderers in `tui`, `app`,
  `session-ui`, `opencode/src/cli/cmd/run`.
- Risk: a new part type is dropped by any consumer that branches on `type`. Mitigated by
  the guard test and a consumer inventory (task 2.4).
- Old stored messages stay synthetic text; no migration.
