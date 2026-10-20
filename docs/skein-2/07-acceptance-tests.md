# Skein 2.0 — Acceptance Test Plan

The mandatory end-to-end acceptance scenarios (charter §20) plus the invariants every
scenario must hold. A capability is not complete without passing its acceptance tests
(charter §0). Each scenario names the owning spec and the verification method.

Repo: `androidand/opencode-skein`.

## 1. Invariants (hold in every scenario)

- **No lost work.** A work item that started is either completed or still discoverable.
- **No double-execution.** A non-idempotent operation is never run twice after a crash.
- **No orphaned claims / leaked leases.** Every claim is released; every lease is returned.
- **Recovery from state, not transcripts.** Recovery reads durable records + actual repo
  state, never the chat transcript.
- **Authority is durable.** No privilege is granted by a message claiming authority.
- **No fabricated state.** A degraded/unreachable surface shows degraded, not invented.

## 2. Scenarios A–H

### Scenario A — ACP compatibility (`acp-external-verification`, #118)
An **independent** ACP client (Python or Rust SDK, protocol v1 — not the agent's TS SDK)
creates a session, submits a coding prompt, receives streamed updates, responds to a
permission request, and cancels an active turn. All operations succeed through the modern
SDK.
- **Verify:** external-client harness in CI; gates removal of the deprecated compat switch.

### Scenario B — Detachment (`project-server`)
Start a project agent from a terminal; close the terminal; the agent continues; reconnect
from a different client and inspect its state.
- **Verify:** launch agent, `kill` the TUI, assert the session is still running on the
  project server; attach a second client; state matches.

### Scenario C — Autonomous crew (`autonomous-swarm` epic #97 + children)
One objective to a lead; the lead plans and delegates two independent assignments; workers
execute in separate worktrees; one asks another for assistance; both complete with
evidence; an independent reviewer finds an intentional defect; the defect is repaired and
re-reviewed; the workflow advances automatically.
- **Verify:** scripted objective with a planted defect; assert delegation, worktree
  isolation, peer assistance, review loop, and auto-advance.

### Scenario D — Recovery (`project-server`, `skein-control-plane`)
Kill a worker that owns a work item. Verify: worktree preserved, task still discoverable,
ownership reconciled, recovery safe, no duplicate merge. Kill and restart the project
server and repeat.
- **Verify:** `kill -9` the worker mid-task; assert invariants; repeat with the server.

### Scenario E — GPU scheduling (`skein-pool`, `skein-control-plane`)
Saturate one inference host; introduce ready work suitable for another host. Verify
scheduling uses available capacity without double-booking; a warm suitable session is
reused when beneficial; unsuitable models are not selected merely for capacity.
- **Verify:** drive llama-skein leases to saturation; assert no double-booking, warm
  reuse, and model-suitability filtering.

### Scenario F — Cross-repository workflow (`skein-control-plane`, `auto-across-repos`)
Create work with dependencies across two repositories. The system detects the dependency
and assigns independent work concurrently where possible; dependent integration waits for
prerequisite evidence.
- **Verify:** two-repo objective with a cross-repo dependency; assert ordering +
  concurrency of the independent parts.

### Scenario G — AHP synchronization (`ahp-host`, #119)
Connect two clients to the same managed agent session; both receive synchronized state;
disconnect and reconnect one; verify correct reconciliation.
- **Verify:** two AHP clients on one session; assert identical `serverSeq`-ordered state;
  reconnect; assert reconciliation without divergence.

### Scenario H — Overnight autonomy (`skein-soak-hardening`, #123)
Provide a backlog with ready work, blocked work, work requiring review, a deliberately
failing test, a task requiring operator approval, and more tasks than inference slots. Run
unattended for a substantial period. Verify: useful work advances; healthy agents are not
unnecessarily interrupted; failed work is bounded; ready work is not silently abandoned;
resource contention is managed; unauthorized actions are refused; decisions requiring
human input remain pending; completed work carries verifiable evidence.
- **Verify:** the soak harness with the mixed backlog; assert each of the eight checks.

## 3. Mapping

| Scenario | Owning spec(s) | Method |
|---|---|---|
| A | `acp-external-verification` | external-client CI harness |
| B | `project-server` | TUI kill + re-attach |
| C | `autonomous-swarm` (#97) + children | scripted objective + planted defect |
| D | `project-server`, `skein-control-plane` | kill -9 worker + server |
| E | `skein-pool`, `skein-control-plane` | lease saturation |
| F | `skein-control-plane`, `auto-across-repos` | two-repo dependency |
| G | `ahp-host` | two-client reconciliation |
| H | `skein-soak-hardening` | unattended soak + mixed backlog |

## 4. Exit criteria

- Every scenario passes its invariants (§1).
- Each scenario's owning spec has the corresponding task checked off.
- The soak (H) runs for the charter §21 target duration with the §17 metrics collected.
- No scenario is marked complete on a mock-only path; A, B, D, G, H require real
  processes/clients.
