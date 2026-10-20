# Change: skein-observability

## Why

Charter §17 requires structured telemetry, correlation across operations, metrics, and
diagnostic CLI commands, and the system must be diagnosable without the dashboard.

Research (R10) found the Go `skein` repo already has `internal/metrics` (per-provider/
model/stage efficiency accounting, D1 fleet-efficiency-metrics; throughput) and
`internal/traces`, but **no OpenTelemetry** in `go.mod`. This change adds OpenTelemetry
where suitable, an explicit correlation-ID convention across the planes, the charter §17
metrics, and the diagnostic CLI — building on the existing metrics/traces rather than
replacing them.

## What Changes

- Adopt OpenTelemetry where suitable (traces + metrics), building on the existing
  `internal/metrics` and `internal/traces`.
- Correlate every operation through `objective_id`, `work_item_id`, `execution_id`,
  `agent_id`, `session_id`, `turn_id`, `model_request_id`, `resource_lease_id`,
  `trace_id`.
- Expose the charter §17 metrics (throughput, efficiency, claim latency, lease usage,
  error rates) and the diagnostic commands `skein status|projects|agents|work|fleet|
  trace|doctor`, reconciled with the existing Go `skein` CLI.
- The AHP `ahp-otlp:` telemetry channel is a natural fit for host telemetry.

## Impact

- Affected specs: `skein-observability` (new, cross-cutting), `skein-control-plane`
  (correlation IDs), `ahp-host` (OTel telemetry channel), `mission-control` (metrics
  views).
- Additive telemetry; disabling the exporter restores prior behavior.
