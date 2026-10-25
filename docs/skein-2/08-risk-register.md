# Skein 2.0 — Risk Register

Charter §3 deliverable (missing until 2026-10-25). Sources: `skein2-plan-evaluation.md`
§9, traps 1–9 in `skein2-p1.2-findings.md`, plus register items surfaced while
completing this deliverable set. Every risk has a mitigation and a *detectable
trigger* — a check that fires while the risk is growing, not after the outage.

Severities: S1 schedule-threatening, S2 quality/rework, S3 annoyance.

| ID | Risk | Sev | Likelihood | Lead-to if unmanaged | Mitigation | Trigger/monitor |
|---|---|---|---|---|---|---|
| K1 | Plugin API churn in opencode v2 (~6 weeks old at audit; Effect/Promise split fresh) | S1 | high | Every port change breaks per release; the exact cost the pivot promised to remove | Pin a tagged release (v2.1.3). Thin adapters between skein logic and the plugin surface, so upgrade-diff touches adapters only | Re-run the P1.2 acceptance probe (`plugin.list` + tool/command/RPC/UI registration) on every opencode bump |
| K2 | `loop.ts` rewrite scope — 105 KB, hook points gone | S1 | high | The port's schedule blows; the fork temptation returns | Plan as rewrite (P1.5). Re-derive loop behavior from `crew-loop`/`swarm-coordinator` specs and the test suites, not the old file | Phase P1.5 estimation review with the old hook-point diff in hand, before code |
| K3 | Plugin crash takes host down (in-process) — `core/src/plugin/supervisor.ts` isolation unverified | S1 | medium | One route crash kills user sessions | Verify supervisor isolation in `plugin-repo-layout` Phase 0 *before* porting TUI-heavy code; wrap every ported route render in the debug guard (P1.2 trap 8) until proven | A deliberate kill-test: crashing plugin must leave the host responsive; recorded evidence per release |
| K4 | `effect` pin drift | S2 | high (every upstream bump) | Avalanche of type errors, misread as code bugs | Exact-pin + `overrides` (P1.2 trap 1); CI assert exactly one `effect` in the tree | CI grep count gate in `plugin-repo-layout` |
| K5 | Silent plugin non-loading (trap 3) | S2 | medium | Agents miss tools/commands without any log line | CI probe `Host.resolve` per plugin; loud startup self-report in the probe route | CI: every configured plugin resolves and `plugin.list` sees it |
| K6 | 26-change OpenSpec queue against the dead layout | S2 | certain | Implementation lands into a tree scheduled for deletion | P1.9 reconcile-before-implement; this register + `06-work-breakdown.md` are the ordering authority | specsync dry-run shows any change worked on whose classification is still unresolved |
| K7 | 20 in-flight worktrees invalidated by the port | S2 | certain | Lost or conflicting work; double-ownership (charter §23) | Evaluation §8 decision 4 (user): land / abandon / freeze, per branch, recorded | A `06-work-breakdown.md` row per worktree with disposition — none unclassified |
| K8 | Shallow clone bites again | S2 | medium | Ancestry claims wrong; upstream patches misattributed | Unshallow in P1.0; assert as a check in `v2-rebaseline` (`git rev-list --count HEAD …` bounded) | any ancestry statement without an unshallow assertion is invalid |
| K9 | llama-skein lease API gaps (no renewal/list; in-memory) — double-booking windows | S2 | medium | Two processes hold one slot (charter §11.5 violation); GPU scheduling broken under contention | ADR 7 holds authority single; R4 decision with llama-skein owner: renewal+list endpoints vs client-side renewal model | llama-skein lease endpoint contract test; controller refusing un-renewable leases |
| K10 | specsync write-mostly — no ready-work/claimable query (R5) | S2 | high | Cross-repo autonomy cannot read work; fabricating another priority store violates §10.1/§23 | Decide R5: specsync read endpoint vs control-plane tracker query; fallback to unchanged tracker until decided | `auto-across-repos` ready-work task blocked-marker honored |
| K11 | Walking-skeleton unverified leg: tool never invoked by a model (no creds in scratch) | S3 | low | Tool-path wiring wrong for agent contexts only | Smoke task in `port-local-plugins` Phase 1 with real creds via `ek` | first model-invoked port test recorded |
| K12 | TUI-driving harness is proprietary to the skeleton session (trap 9: PTY/capability negotiation work) | S3 | medium | Visual dialog regression tests in P1.3+ never get written; regressions ship silently | Promote `tui-drive.py` into the plugin repo's test kit (P1.3) | CI runs at least one driven TUI test |
| K13 | Fork-era data/config layouts (v1 state dirs) not migrated by v2 launch | S2 | medium | Silent loss of sessions/state when the fork is dropped | `v2-rebaseline` records all fork-specific mutable paths; `adopt-upstream-acp-and-service` decides migrate-or-fresh | migration test against a real state dir snapshot |
| K14 | Peer context poisoning on session reuse (a reused idle session drags stale, unrelated context into a new assignment) | S3 | low | Agents repeat settled work or act on wrong context | Session-reuse policy honors the "context appropriate" test (charter §8.8); crew routing re-checks task fit | placement regression including a session-reuse case (§11.4 row 3) |
| K15 | Divergent plan copies: loose `~/dev/skein2-*.md` vs doc-side copies | S3 | medium (observed) | Agents follow a stale plan copy; two truths drift | Loose companions stay working-copy; this doc set in `docs/skein-2/` is authoritative; each ends with a sync date; header banner in the charter points here | every planning doc cites its revision date; diff check in P1.8 (`skein doctor`) reading both copies |
| K16 | Cancelled `skein2/acp-sdk-1.8` route keeps attracting work | S3 | low (observed — the stray uncommitted 1.8.0 bump sits in the phase0 worktree) | Effort into a closed route | Evaluation decision 3 (archive). The stray 1.8.0 bump files are left untouched and reported for disposal | branch marked archived in breakdown; the stray bump tracked until disposed |

## Decision debt this register cannot absorb

These are operator decisions (evaluation §8), not risks to mitigate without an answer:
plugin repo layout (ADR 13 pending — recommendation written in `plugin-repo-layout`),
`skein2/acp-sdk-1.8` fate (recommend archive), worktree dispositions (K7), and
release-pin cadence beyond v2.1.3 (K1 is scoped to the P1.0 pin until changed).
