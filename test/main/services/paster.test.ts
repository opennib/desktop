import { describe, expect, it, vi } from "vitest"

import { PasterError } from "@opennib/core"

import { MacPaster } from "../../../src/main/services/paster"

function makePaster(overrides: {
  writeText?: (t: string) => void
  exec?: (p: string) => Promise<void>
  pasteHelperPath?: string
  clipboardSettleMs?: number
} = {}) {
  const writeText = overrides.writeText ?? vi.fn()
  const exec = overrides.exec ?? vi.fn(async () => {})
  const pasteHelperPath = overrides.pasteHelperPath ?? "/path/to/paste-helper"
  const clipboardSettleMs = overrides.clipboardSettleMs ?? 0
  const paster = new MacPaster({
    clipboard: { writeText },
    exec,
    pasteHelperPath,
    clipboardSettleMs,
  })
  return { paster, writeText, exec, pasteHelperPath }
}

describe("MacPaster", () => {
  it("writes the text to the clipboard then runs the paste helper", async () => {
    const order: string[] = []
    const writeText = vi.fn(() => order.push("clipboard"))
    const exec = vi.fn(async () => {
      order.push("exec")
    })
    const { paster } = makePaster({ writeText, exec })

    await paster.paste("hello")

    expect(writeText).toHaveBeenCalledWith("hello")
    expect(exec).toHaveBeenCalledOnce()
    expect(order).toEqual(["clipboard", "exec"])
  })

  it("invokes the helper at the configured path", async () => {
    const exec = vi.fn(async () => {})
    const { paster } = makePaster({ exec, pasteHelperPath: "/usr/local/bin/paste-helper" })
    await paster.paste("hi")
    expect(exec).toHaveBeenCalledWith("/usr/local/bin/paste-helper")
  })

  it("waits the configured settle duration between clipboard and exec", async () => {
    vi.useFakeTimers()
    try {
      const writeText = vi.fn()
      const exec = vi.fn(async () => {})
      const paster = new MacPaster({
        clipboard: { writeText },
        exec,
        pasteHelperPath: "/x",
        clipboardSettleMs: 200,
      })
      const promise = paster.paste("delayed")
      expect(writeText).toHaveBeenCalled()
      expect(exec).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(199)
      expect(exec).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await promise
      expect(exec).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it("wraps clipboard failures as PasterError", async () => {
    const cause = new Error("clipboard locked")
    const writeText = vi.fn(() => {
      throw cause
    })
    const exec = vi.fn(async () => {})
    const { paster } = makePaster({ writeText, exec })

    await expect(paster.paste("x")).rejects.toBeInstanceOf(PasterError)
    expect(exec).not.toHaveBeenCalled()
  })

  it("wraps exec failures as PasterError with cause", async () => {
    const cause = new Error("ENOENT paste-helper")
    const exec = vi.fn(async () => {
      throw cause
    })
    const { paster } = makePaster({ exec })

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
    const exec = vi.fn(async () => {
      order.push("exec")
    })
    const { paster } = makePaster({ writeText, exec, clipboardSettleMs: 0 })
    await paster.paste("hi")
    expect(order).toEqual(["clipboard", "exec"])
  })
})
