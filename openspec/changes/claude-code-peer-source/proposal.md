# Read Claude Code sessions as first-class peers in the Agents roster

**Depends on `fleet-instance-presence`.** This adds a second source to the presence model
that change defines. It does not alter that model's transport, and it adds no new one.

## Why

The human runs Claude Code and opencode-skein side by side, all day, across worktrees of
the same repos. `fleet-instance-presence` makes skein instances visible to each other and
solved half the problem. The other half is that roughly half the running agents are not
skein instances, and to the roster they do not exist. An `/agents` view that omits them
answers "what is everything doing" wrongly, which is worse than not answering.

The work needed here is small, because Claude Code already publishes exactly this data
locally. Verified on 2026-09-11 against Claude Code v2.1.268:

- `claude agents --json` prints every live session — interactive and background — as
  `{pid, cwd, kind, startedAt, sessionId, name, status}`, with `--all` and `--cwd <path>`.
  It is a supported, documented CLI surface and does not require a TTY.
- The same data is on disk at `~/.claude/sessions/<pid>.json`, which additionally carries
  `version`, `peerProtocol`, `peerFeatures`, `messagingSocketPath`, `entrypoint`,
  `statusUpdatedAt` and the session's display `name`.

So this change is an adapter, not an integration. Read the CLI, normalize, merge.

## What Changes

### 1. `Owner` widens from a literal to a union

`packages/opencode/src/agent/presence.ts` defines
`Owner = Schema.Literal("opencode-skein")`. It becomes
`Schema.Literal("opencode-skein", "claude-code")`.

This is the load-bearing edit. Everything downstream — `/agents`, the TUI view, skein's Go
aggregator — already keys off `owner`, so widening it is what makes a Claude session a
peer rather than a special case. Consumers that cannot handle a foreign owner must be
found and fixed as part of this change, not discovered later.

### 2. A Claude Code presence source

A new source module reads `claude agents --json` (preferring the CLI over the on-disk
registry; the registry is the fallback when the binary is absent) and maps each session
into the existing `Info` record:

| `Info` field | Source | Note |
|---|---|---|
| `owner` | constant | `"claude-code"` |
| `instanceID` | `pid` | one process per session, unlike skein |
| `sessionID` | `sessionId` | a UUID, not `ses_…` — see task 1.2 |
| `directory` | `cwd` | |
| `status` | `status` | `idle` maps to `idle`; **absent means busy** |
| `lastEventAt` | `statusUpdatedAt`, else `startedAt` | |
| `heartbeatAt` | file mtime / poll time | |
| `canPrompt`/`canBtw`/`canAbort` | `false` for now | raised by `claude-peer-messaging` |
| `agent`/`provider`/`model`/`loop*` | unset | Claude does not publish these |

Fields Claude does not publish stay **absent**, never guessed. A roster that invents a
model name is worse than one that admits it does not know.

The session's `name` is carried through as the display name. This matters more than it
looks: the human's `/fanout` workflow names sessions `<slug>-<role>`, so the name is
frequently the only thing that says what a peer is actually doing.

### 3. Freshness, not liveness

Claude sessions are discovered by polling, so a record is a snapshot. Each record carries
its observation time, and a record whose source process is gone is reported `unreachable`
— the same distinction `fleet-instance-presence` already draws between a crashed instance
and a cleanly exited one. Claude's registry is keyed by pid, so liveness is a cheap
`kill(pid, 0)`-equivalent check rather than a timeout.

### 4. Work identity via `specsync topology`

A directory is not a unit of work. Where `specsync` is available, its
`topology -json` (specsync change `agent-topology-command`) is read and each peer is
annotated with the change slug, tracker issue and branch matched by worktree path — for
skein sessions and Claude sessions alike, since the join is on directory, not on owner.

This is the payoff: `/agents` stops being a list of directories and becomes a list of
*who is working on which change*. Absent specsync, peers still list with directories.

### 5. Scope

Local machine only. Claude's registry and sockets are per-user and per-host; there is
nothing to discover over mDNS, so this source is not advertised to the network and does
not extend `fleet-instance-presence`'s network surface.

## Capabilities

### MODIFIED Capabilities

- `agent-presence`: gains a second owner and a local, poll-based source for it.

## Non-Goals

- **No messaging, prompting, or control.** Read-only. Every control capability is
  published `false`. Talking to a Claude peer is `claude-peer-messaging`, deliberately
  separate because it depends on a private protocol and this does not.
- **No writes into `~/.claude/`.** Nothing in this change creates, edits or deletes a file
  under Claude Code's state directory.
- No reading Claude transcripts, prompts or tool output. Metadata only — the same
  content-suppression rule `fleet-instance-presence` already enforces, and it is tested
  the same way.
- No claiming or mutual exclusion. Seeing a peer on a slug is not reserving it.
- Not a Claude Code plugin, hook, or MCP server. skein reads a public CLI; Claude Code is
  not modified and need not know skein exists.

## Risks

- **`claude agents --json` is a CLI contract that can change.** Mitigation: parse
  defensively, treat unknown fields as ignorable and missing fields as absent, and fail
  the source (not the roster) on a shape that no longer matches. A broken Claude source
  must degrade to "no Claude peers", never to a broken `/agents`.
- **Polling cost.** Mitigation: poll on roster read with a short cache, not on a timer.
- **Path disclosure.** Claude `cwd` values are absolute paths, already the same class of
  data `fleet-instance-presence` publishes. Because this source is local-only and never
  advertised, it does not widen that exposure.

## Impact

- Changed: `packages/opencode/src/agent/presence.ts` (`Owner`), and every consumer that
  assumed a single owner.
- New: a Claude source module under `packages/opencode/src/agent/`, a topology reader, and
  their tests.
- `/agents` gains an owner column and a slug column.
