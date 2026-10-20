# Tasks: skein-observability

## Phase 1: Correlation IDs

- [ ] 1.1 Define the correlation-ID set (objective/work_item/execution/agent/session/turn/
      model_request/lease/trace) and propagate it across the control plane, project
      servers, ACP runtime, and AHP host.
- [ ] 1.2 A work item's full history is reconstructable from its correlation IDs alone.

## Phase 2: OpenTelemetry

- [ ] 2.1 Add OpenTelemetry (traces + metrics) where suitable, building on the existing
      `internal/metrics` and `internal/traces`. **needs-research**: exact OTel SDK and
      exporter for the Go runtime and the TS project server.
- [ ] 2.2 Export the charter §17 metrics: throughput, efficiency, claim latency, lease
      usage, error rates.
- [ ] 2.3 Use the AHP `ahp-otlp:` telemetry channel for host telemetry.

## Phase 3: Diagnostic CLI

- [ ] 3.1 `skein status|projects|agents|work|fleet|trace|doctor` (charter §17),
      reconciled with the existing Go `skein` CLI conventions.
- [ ] 3.2 `skein trace <work_item_id>` reconstructs the full operation history from
      correlation IDs.
- [ ] 3.3 The system is diagnosable headless (CLI), without the dashboard.
