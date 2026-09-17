import { PasterError } from "@opennib/core"
import { describe, expect, it, vi } from "vitest"

import { SystemPaster } from "../../../src/main/services/system-paster"

function makePaster(overrides: {
  writeText?: (t: string) => void
  spawnPaste?: () => Promise<void>
  clipboardSettleMs?: number
} = {}) {
  const writeText = overrides.writeText ?? vi.fn()
  const spawnPaste = overrides.spawnPaste ?? vi.fn(async () => {})
  const clipboardSettleMs = overrides.clipboardSettleMs ?? 0
  const paster = new SystemPaster({
    clipboard: { writeText },
    spawnPaste,
    clipboardSettleMs,
  })
  return { paster, writeText, spawnPaste }
}

describe("SystemPaster", () => {
  it("writes the text then runs the spawn callback", async () => {
    const order: string[] = []
    const writeText = vi.fn(() => order.push("clipboard"))
    const spawnPaste = vi.fn(async () => {
      order.push("spawn")
    })
    const { paster } = makePaster({ writeText, spawnPaste })

    await paster.paste("hello")

    expect(writeText).toHaveBeenCalledWith("hello")
    expect(spawnPaste).toHaveBeenCalledOnce()
    expect(order).toEqual(["clipboard", "spawn"])
  })

  it("waits the configured settle duration between clipboard and spawn", async () => {
    vi.useFakeTimers()
    try {
      const writeText = vi.fn()
      const spawnPaste = vi.fn(async () => {})
      const paster = new SystemPaster({
        clipboard: { writeText },
        spawnPaste,
        clipboardSettleMs: 100,
      })
      const promise = paster.paste("delayed")
      expect(writeText).toHaveBeenCalled()
      expect(spawnPaste).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(99)
      expect(spawnPaste).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await promise
      expect(spawnPaste).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it("wraps clipboard failures as PasterError and skips spawn", async () => {
    const writeText = vi.fn(() => {
      throw new Error("clipboard locked")
    })
    const spawnPaste = vi.fn(async () => {})
    const { paster } = makePaster({ writeText, spawnPaste })

    await expect(paster.paste("x")).rejects.toBeInstanceOf(PasterError)
    expect(spawnPaste).not.toHaveBeenCalled()
  })

  it("wraps spawn failures as PasterError with cause", async () => {
    const cause = new Error("xdotool not found")
    const spawnPaste = vi.fn(async () => {
      throw cause
    })
    const { paster } = makePaster({ spawnPaste })

    try {
      await paster.paste("x")
      throw new Error("expected PasterError")
    } catch (err) {
      expect(err).toBeInstanceOf(PasterError)
      expect((err as PasterError).cause).toBe(cause)
    }
  })

  it("skips the settle delay when clipboardSettleMs is 0", async () => {
    const order: string[] = []
    const writeText = vi.fn(() => order.push("clipboard"))
    const spawnPaste = vi.fn(async () => {
      order.push("spawn")
    })
    const { paster } = makePaster({ writeText, spawnPaste, clipboardSettleMs: 0 })
    await paster.paste("hi")
    expect(order).toEqual(["clipboard", "spawn"])
  })
})
