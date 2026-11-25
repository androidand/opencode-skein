/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { MemBreakdown } from "../../src/feature-plugins/sidebar/context"
import type { MemSnapshot } from "../../src/local/model-fit"

const theme = { textMuted: "#888888", warning: "#ffaa00", accent: "#00aaff" }
const sample = (over: Partial<MemSnapshot>): MemSnapshot => ({
  usedMb: 100, freeMb: 24000, totalMb: 24560, label: "VRAM", modelMb: 0, kvEstMb: 0, ...over,
})

// per-model-placement-controls task 12: the readout showed `0.1 / 24.0 GB`
// beside a 91% bar. MemBreakdown copied `props.mem` once at creation, so it
// kept the FIRST sample (taken while the model was still loading) while the bar
// — which reads the signal — kept updating. It must follow the signal.
test("the memory readout follows later samples instead of freezing the first", async () => {
  const [mem, setMem] = createSignal(sample({}))
  const app = await testRender(() => <MemBreakdown mem={mem()} theme={theme} />, { width: 60, height: 4 })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("0.1 / 24.0")

    setMem(sample({ usedMb: 22000, modelMb: 18000, kvEstMb: 3000 }))
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("mod 17.6")
    expect(frame).not.toContain("0.1 / 24.0")
  } finally {
    app.renderer.destroy()
  }
})
