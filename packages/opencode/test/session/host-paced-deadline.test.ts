import { describe, expect, test } from "bun:test"
import { Provider } from "@/provider/provider"

// Regression: opencode abandoned a working turn on a hybrid-placed model with
// "Provider stream stalled: no events for 300s". The model was fine — measured
// on z4, 254s can pass before the FIRST token of any kind while ~50 GB of
// expert weights fault back in, and generation then runs at ~0.8 tok/s.
describe("host-paced model registry", () => {
  test("an unknown model is not host-paced", () => {
    expect(Provider.isHostPaced("nope", "nothing")).toBe(false)
  })

  // The registry is populated during model discovery from llama-skein's
  // placement.perf_class; absent placement data must never mark a model paced,
  // so a non-llama-skein provider keeps the normal deadline.
  test("absence of placement data leaves a model unpaced", () => {
    expect(Provider.isHostPaced("openai", "gpt-4")).toBe(false)
  })

  // A discovery pass where the fit probe raced its abort budget (host busy —
  // which correlates with a host-paced model being loaded or generating) must
  // NOT wipe a previously-known verdict; that would re-arm the 300s deadline
  // for exactly the model that needs the 1800s floor. Fresh fit data stays
  // authoritative in both directions.
  test("a failed fit probe keeps the previous verdict; fresh data overrides", () => {
    Provider.noteHostPaced("z4", "big-moe", { hostPaced: true })
    expect(Provider.isHostPaced("z4", "big-moe")).toBe(true)

    // probe lost the race: no fit report for this pass
    Provider.noteHostPaced("z4", "big-moe", undefined)
    expect(Provider.isHostPaced("z4", "big-moe")).toBe(true)

    // re-placed fully GPU-resident: fresh data clears the flag
    Provider.noteHostPaced("z4", "big-moe", { hostPaced: false })
    expect(Provider.isHostPaced("z4", "big-moe")).toBe(false)
  })
})

// Regression: a fully GPU-resident 35B-A3B model configured with a 262144
// ctx-size on an M3 Mac (kat-coder-v2.5-apex-i-compact) never answered a
// single request through opencode-skein. It was not host-paced (perf_class
// was native-gpu, not cpu-bound-hybrid) — it was just slow to first token, a
// distinct cause (KV-cache allocation + prefill time scale with configured
// ctx-size regardless of placement). opencode's 600s headerTimeout aborted
// before the model answered; each abort read, from llama-skein's side, as a
// client disconnect from a hung backend, triggering its own wedge-recovery
// restart that really did kill the merely-slow backend — silently, on every
// retry. isSlowColdStart is the signal that lets the header timeout get the
// same patient floor isHostPaced already gets for a different reason.
describe("slow-cold-start model registry", () => {
  test("an unknown model is not flagged slow-cold-start", () => {
    expect(Provider.isSlowColdStart("nope", "nothing")).toBe(false)
  })

  test("a small configured ctx is not flagged", () => {
    Provider.noteSlowColdStart("m3", "small-model", { configuredCtx: 8192 })
    expect(Provider.isSlowColdStart("m3", "small-model")).toBe(false)
  })

  test("a very large configured ctx is flagged, and clears when reconfigured smaller", () => {
    Provider.noteSlowColdStart("m3", "kat-coder-v2.5-apex-i-compact", { configuredCtx: 262144 })
    expect(Provider.isSlowColdStart("m3", "kat-coder-v2.5-apex-i-compact")).toBe(true)

    // a config reload dropping ctx-size back down should un-flag it
    Provider.noteSlowColdStart("m3", "kat-coder-v2.5-apex-i-compact", { configuredCtx: 8192 })
    expect(Provider.isSlowColdStart("m3", "kat-coder-v2.5-apex-i-compact")).toBe(false)
  })

  test("a failed fit probe keeps the previous verdict", () => {
    Provider.noteSlowColdStart("m3", "big-ctx-model", { configuredCtx: 262144 })
    expect(Provider.isSlowColdStart("m3", "big-ctx-model")).toBe(true)

    Provider.noteSlowColdStart("m3", "big-ctx-model", undefined)
    expect(Provider.isSlowColdStart("m3", "big-ctx-model")).toBe(true)
  })
})
