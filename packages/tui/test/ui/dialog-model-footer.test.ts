import { describe, expect, test } from "bun:test"
import { formatModelSize } from "../../src/component/dialog-model"
import { flattenedFooter } from "../../src/ui/dialog-select"

const GiB = 1024 ** 3

describe("component.dialog-model.formatModelSize", () => {
  test("folds the host's memory total into the size: weights/total GB", () => {
    // 31.9 GB host, 27.2 GB model — the row from the reported screenshot.
    expect(formatModelSize(27.2 * GiB, 31.9 * 1024)).toBe("27.2/31.9 GB")
  })

  test("size alone when the host total is unknown", () => {
    expect(formatModelSize(27.2 * GiB)).toBe("27.2 GB")
    expect(formatModelSize(27.2 * GiB, 0)).toBe("27.2 GB")
  })

  test("sub-GB models keep MB without a host total, GB with one", () => {
    expect(formatModelSize(512 * 1024 ** 2)).toBe("512 MB")
    expect(formatModelSize(512 * 1024 ** 2, 31.9 * 1024)).toBe("0.5/31.9 GB")
  })

  test("unknown size stays unknown even with a host total", () => {
    expect(formatModelSize(undefined, 31.9 * 1024)).toBeUndefined()
    expect(formatModelSize(0, 31.9 * 1024)).toBeUndefined()
  })

  test("regression: a filtered row reads 'size/total GB · host', with no second VRAM figure", () => {
    // Was "27.2 GB · host-a · 31.9 GB VRAM", which pushed the model
    // name off the row so near-identical quantizations were indistinguishable.
    const footer = flattenedFooter({
      title: "Ornith 1.5 35B-A3B-AD-Q6_K",
      value: undefined,
      footer: formatModelSize(27.2 * GiB, 31.9 * 1024),
      provenance: "host-a",
    })
    expect(footer).toBe("27.2/31.9 GB · host-a")
  })
})
