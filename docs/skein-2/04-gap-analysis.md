# Skein 2.0 — Gap Analysis

Charter §3 deliverable. This is the full evidence-matrix walk (the matrix in
`06-work-breakdown.md` §2 is the summary; §4 there records the reconciliations).
Written 2026-10-25 against the revised (opencode 2 plugin) phase structure, so it
also records gaps that the v2 pivot *closed for free* and gaps it *opened*.

Evidence rule (charter §2.1): a capability counts as present only with a file path,
branch, commit, or live run behind it. Repo documents are never proof by themselves.

---

## 1. Fork-vs-upstream structural gap (the pivot driver)

| Item | Was (fork `dev` @ 5fea944430) | Upstream v2.1.3 | Verdict |
|---|---|---|---|
| ACP | Own `acp/` adapter on interface-based API, `@agentclientprotocol/sdk` 0.21.0; fluent 1.8.0 migration proven on `skein2/acp-sdk-1.8` | ACP shipped natively | **Gap closed by upstream.** Adopt; archive in-fork work (evaluation decision 3) |
| Server independence | doc-claimed; never verified vs charter §7.6 | `opencode service` exists upstream | **Unverified claim.** Verify under `adopt-upstream-acp-and-service` (P1.7) |
| Plugin surface | None — every Skein feature patches fork internals (241 modified files) | Real plugin system; 92 plugins incl. ~89 builtins registering tools/commands/RPC/TUI routes | **Gap closed by upstream.** Proven viable under P1.2 |
| Upgrade cost | 500–700 commit gap; `sustainable-upstream-sync` stalled in the queue; merge tooling exists but the port cost recurred | Plugin pin (`effect` 4.0.1) + API churn is now the upgrade cost | Mixed — smaller, per-plugin instead of per-tree |

## 2. Capability matrix (charter §3 rows, evidence-based)

| Capability | Audit / verification message | Evidence | Missing work | Priority |
|---|---|---|---|---|
| ACP | In-fork modernization cancelled; verification of upstream remains | `skein2/acp-sdk-1.8` commits `b1cc0672fd`, `7ec992ed6c`, `2c0b8a2fc2` (docs + gaps recorded); upstream native | External-client verification (Scenario A) vs upstream; §6.4 checklist; drop compat switch | P0 |
| A2A / peer | Implemented and in use between sessions; delegate pending-reply registry is process-local | `peer/delegate.ts`; three `review-*` finding worktrees exercised it live | Durable delegation: correlation IDs, at-least-once delivery, idempotent outcomes, exactly-one committed outcome (P1.4) | P0 |
| Project server | Specified; lifecycle spikes done (0.1, 0.3, 0.4, 0.5); not implemented in the fork | `project-server` spec + `findings.md`; upstream `opencode service` exists | Verify §7.6 ten assertions against `opencode service`; gap-fill; `DurableAgentExecution` in plugin-owned durable state | P0 |
| Autonomous crew | Partial: shared-file claims landed (`813393f21a`), loop registry still in-memory; crew stops when an assignment ends | `crew-loop`, `swarm-coordinator` specs | Handoff to next assignment, claim fencing, policy-gated integration (P1.5) | P0 |
| Control plane | Not built | `swarm-coordinator` is in-server by design; charter §9.1 wants independent | Go + PostgreSQL coordinator; reuses Go `skein` domain primitives (R3/R6) | P1 |
| AHP | Not started | AHP spec; conforming hosts exist (`ahp-acp-gateway`, `ahpd`, …) | First: evaluate upstream desktop/session-UI redundancy; then read-only host (Scenario G) | P2 |
| Mission Control | Not started | `packages/web` is an Astro docs site (R9), no dashboard exists | Independent small dashboard; agent detail, work graph, lead chat, approvals | P2 |
| Observability | Not started | No OTel in opencode-skein; Go `skein` has `internal/metrics` + `internal/traces` without OTel | OTel SDK/exporter choice (R10 partial), correlation-ID propagation, diagnostic CLI (P1.8) | P1 |
| GPU scheduling | Partial: placement exists (`src/local/`, `per-model-placement-controls`); leases in-memory TTL-only in llama-skein | `api/slots/lease` POST/DELETE, no renewal/list (`apisleasing.go`) | Lease renewal/list in llama-skein (R4), controller request-side integration; §11.4 placement regressions | P1 |
| Cross-repo | `auto-across-repos` specified; loop `--auto` flag landed through Phase 6.1/6.2 tests (`1ecc4db407`, `a97d9b7ec4`) | specsync `changes --json` lacks ready-work/dependency query (R5) | Ready-work contract endpoint or control-plane-side tracker query | P1 |

## 3. Gaps the v2 pivot opened (must be tracked, they are easy to miss)

| Gap | Why it exists | Owner |
|---|---|---|
| Plugin crash isolation unverified | `core/src/plugin/supervisor.ts` never tested under failure (P1.2 left it open) | `plugin-repo-layout` Phase 0 task |
| `effect` pin drift on every opencode upgrade | P1.2 trap 1: range-installed second `effect` copy; symptom is type avalanches, not warnings | CI gate in `plugin-repo-layout` |
| Silent plugin non-loading | P1.2 trap 3: unresolvable entrypoints are dropped with no log, on any host | CI probe during port; noted for upstream issue |
| 241-file fork delta orphaned | After P1.7 deletes `acp/`, `context/`, `fork/`, remaining delta must be inventoried as upstream PRs or deliberate deviations | `v2-rebaseline` delta map, carried in `06-work-breakdown.md` |
| 26-change OpenSpec queue partially against dead layout | Named dead-layout changes: `crew-loop`, `ctx-aware-subagent-placement`, `model-gallery-ui`, `per-model-placement-controls`, `sustainable-upstream-sync` (evaluation P1.9) | `reconcile-openspec-queue-v2` |
| 20 in-flight worktrees mid-port decision | `shared-claims`, `loop-wip-reconcile`, `peer-message-visibility`, three `review-*` findings land-or-freeze | evaluation decision 4 — user |
| Walking-skeleton model-invocation not verified | Tool never fired by a model (no creds in scratch) | `port-local-plugins` Phase 1 smoke task |
| TUI-driving harness is session-proprietary | `tui-drive.py` lives in the skeleton repo; needed by visual-dialog regression tests in P1.3+ | promote into the plugin repo test kit |
| Data reset risk when the fork changes storage layout | Fork-specific data dirs (config/state formats from v1 dirs) may not migrate to v2 launch | `v2-rebaseline` records the dirs; `adopt-upstream-acp-and-service` decides migration |

## 4. Not-a-gap (checked, closed)

- Bootstrap household / operator HUD analogues are irrelevant here; verified items
  live in `00-current-state.md` and are not re-derived.
- ACP v2 protocol: explicitly out of scope (charter §6.4 last item) — stable v1 first.
- Upstream release from `dev` exactly: pin a tagged release (P1.0), not branch drift.
- The Go `skein` repo is NOT being rewritten; its domain primitives (R6) are extracted
  into `skein-control-plane`.

## 5. What still blocks implementation

1. Evaluation §8 decision items: plugin repo layout (P1.1 ADR — recommended: one repo
   with one plugin per package), fate of `skein2/acp-sdk-1.8` (recommend archive), the
   20 worktrees, and pin-vs-track. P1.2 verdict already settled "go plugins".
2. R4 (llama-skein lease extension) — llama-skein owner decision, not guessable here.
3. R5 (specsync ready-work query) — specsync repo owner decision.
4. R8 (AHP host approach) — parked behind the upstream desktop/UI evaluation.
