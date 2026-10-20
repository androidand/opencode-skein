# Change: skein-soak-hardening

## Why

Charter Phase 8 requires soak testing and hardening: the platform must survive long
running operation, crashes, and distributed load without losing work or double-executing.
The earlier phases build the durable primitives (durable loops, `DurableAgentExecution`,
distributed claims, reconciliation); this change proves them under sustained, adversarial
conditions and fixes what the soak reveals.

## What Changes

- A soak harness that runs the platform (control plane + project servers + agents) for a
  sustained period under realistic load, injecting failures (server kills, network
  partitions, lease expiries, claim races, GPU slot loss).
- Invariant checks during the soak: no lost work, no double-execution of non-idempotent
  operations, no orphaned claims, no leaked leases, no unbounded memory growth.
- Crash-recovery tests: kill -9 at arbitrary points; restart; verify recovery from durable
  records + actual repo state (not transcripts).
- Distributed soak: multiple hosts, multiple repos, cross-repo dependencies.
- A hardening pass that fixes the defects the soak reveals, each with a regression test
  that fails without the fix.

## Impact

- Affected specs: `skein-soak-hardening` (new), `skein-control-plane` (distributed soak),
  `project-server` (crash recovery), `peer-conversation-reliability` (delivery under
  failure).
- A soak harness + invariant checker; no new runtime features (only fixes the soak
  reveals).
