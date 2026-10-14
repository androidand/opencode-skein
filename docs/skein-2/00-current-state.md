# Skein 2.0 — Phase 0: current state (opencode-skein)

Baseline audit for the Skein 2.0 charter (`~/dev/skein2-grand-plan.md`).
Scope of this document: what was **verified in code or by running tests** in
`opencode-skein` at `origin/dev` = `813393f21a`. Anything not checked is marked
"unverified". Repository documents were used only as leads, not as evidence.

Written for: the operator and the next implementing agent.

## 1. Method and baseline

- Worktree: `origin/dev` at `813393f21a`, branch `skein2/phase0-baseline`.
  The shared `dev` checkout was not touched: it holds another session's staged work.
- Dependencies installed with `bun install --frozen-lockfile` (bun 1.3.14).
- Baseline run: `bun test test/cli/acp` in `packages/opencode` →
  **15 pass, 0 fail, 5 test files, 105 expect() calls.**
  Not yet run: the full suite, and any crew/peer/loop tests.

## 2. Capability matrix

Status vocabulary follows the charter's §2.1: *Operational*, *Implemented, not
proven live*, *Partial*, *Not implemented*.

| Capability | Status | Evidence | Missing work | Priority |
|---|---|---|---|---|
| ACP server | **Operational on deprecated API.** Works end to end under its test suite. | `src/acp/` (12 files, ~3.5k lines); `src/cli/cmd/acp.ts:55-58` builds `new AgentSideConnection(...)` over `ndJsonStream`; 5 `acp/` modules import `AgentSideConnection` types; 5 test files pass. | Migrate to the fluent API; SDK is 0.21.0 (see §4). | P0 |
| ACP compatibility with an independent client | **Unverified.** Tests use an in-repo client (`test/cli/acp/acp-test-client.ts`). | Test helper only. | Run against a real external ACP client. | P0 |
| A2A / peer delegation | **Partial.** Peer transport and envelope exist; reply correlation is in memory. | `src/peer/delegate.ts:82` `const pending = new Map<...>()`; only file in `src/` that mentions "a2a". | Durable correlation, deadlines, retries, idempotent settlement. | P0 |
| Crew claims | **Implemented, SQLite-backed, no fencing.** | `src/loop/crew/claims.ts`: `ClaimTable` via drizzle, `heartbeat`/`release` as guarded UPDATEs, `DefaultStaleAfterMs = 60_000`. No `leaseToken`, generation, or fencing field in the claim schema. | Fencing/ownership generation; reconcile live process state before reassignment (charter §8.5). | P0 |
| Crew routing / delegation | **Present, not verified.** | `src/loop/crew/route.ts`, `lead.ts`, `lead-confirm.ts`, `lead-issue.ts`, `envelope.ts`, `inbox.ts`. | Live two-worker run (charter §8.9). | P0 |
| Loop (`/loop`) | **Present, large (`loop.ts` 105 KB).** | `src/loop/loop.ts`, `completion.ts`, `continuation.ts`, `stop-reason.ts`. | Not audited in depth. | P1 |
| OpenSpec queue | **Present.** | `src/loop/spec-queue/` (7 files). | Not audited in depth. | P1 |
| Durable project server | **Not implemented.** | No code references to "project server" or "projectserver" in `src/`. `src/server/` contains the HTTP/event server, not the project supervisor described in charter §7. | Entire lifecycle (§7.3–7.6). | P0 |
| Durable execution records (`DurableAgentExecution`) | **Not implemented.** | No matching table/type found. | Schema plus checkpoint/lease semantics. | P0 |
| Resource leases (inference slots) | **Not implemented in opencode-skein.** | No `lease`/`fencing` hits in `src/loop` or `src/peer`. Placement lives in `src/local/`. | Lease authority belongs in llama-skein (charter §11.5). Unverified in llama-skein. | P1 |
| AHP | **Not implemented.** | No matches. | Phase 7. | P2 |

## 3. Discrepancies between the charter and the repository

1. **OpenSpecs named by the charter are absent.** These names return zero
   matches in `opencode-skein/openspec/` and `skein/openspec/`, and no file
   matching any of them exists under `~/dev` (search timed out at 90 s, so
   "not found" means "not found in the search"):
   `autonomous-swarm`, `project-server`, `swarm-coordinator`, `lead-authority`,
   `standing-publish-authority`, `escalate-before-idle`, `loop-done-handoff`,
   `review-on-done`, `loop-unattended-permission-asks`.
   The charter's dependency reconciliation (Phase 0) cannot be done for these
   until the owner says where they live (or whether they were never written).
2. **The charter names the wrong SDK migration target.** It cites
   `MIGRATION_0.26_0.27.md`. The repo pins `@agentclientprotocol/sdk` **0.21.0**,
   which has no fluent `agent()` builder (`dist/` exports only `ndJsonStream` and
   the classic classes). The npm registry's latest is **1.8.0** (published
   2026-10-09). See §4.
3. **Crew claims are described in the charter as absent.** They exist. The
   gap is fencing and reconciliation, not the claim table itself.
4. **Charter names the file `acp/agent.ts` with an `Agent` class.** The current
   file is 95 lines and is the only place `AgentSideConnection` is passed to a
   factory (`agent.ts:26`). The migration is contained, but touches the event,
   permission, service, and usage modules as well because they take
   `AgentSideConnection` types directly.

## 4. Decision needed before the ACP migration

The fluent builder is not in 0.21.0. Migrating means bumping
`@agentclientprotocol/sdk`, and the charter's target version is out of date.

- Option A: move to the current stable line (1.x). Newest release is 5 days old,
  so it has had little time in the field. It is a major-version jump that the
  charter has not studied.
- Option B: move to the 0.2x line whose migration guide the charter cites.
  Needs confirming that a published version with the fluent API exists.
- Option C: keep the deprecated connection behind a compatibility switch, and
  defer the bump.

Recommendation: **A**, after reading the 1.x changelog and running the 15-test
ACP suite plus the charter's Scenario A against a real external ACP client. Do
not bump the lockfile without that.

## 5. Shared-state hazards found during the audit

- `opencode-skein`: the `dev` checkout has staged and unstaged changes from
  another session. Not touched.
- `skein`, `llama-skein`, `specsync`: each has uncommitted work in its
  primary checkout. Not touched.
- `opencode-skein` remotes: `origin` is `dev`-tracking. A second remote `m5`
  could not be fetched. The push URL reads `BLOCKED-history-was-rewritten`,
  which means a publish is blocked by the owner. No push was made.
- `llama-skein` push URL is also `BLOCKED-history-was-rewritten-...`. Same rule.

## 6. What this phase did not do

- Did not migrate ACP.
- Did not write the other Phase 0 documents (`01`–`08`). Several depend on the
  missing OpenSpecs in §3.1 and on the SDK decision in §4.
- Did not audit `skein`, `llama-skein`, or `specsync` in depth. Only their git
  state was checked.
- Did not run the full opencode test suite.

## 7. Next step

Owner decision: the SDK target (§4), and the location of the missing OpenSpecs
(§3.1). Once those are answered, the ACP migration can start in a fresh
worktree from `origin/dev`, with the 15-test baseline as the regression gate.
