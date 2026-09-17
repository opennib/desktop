import { describe, expect, it, vi } from "vitest"

import { ElectronNotifier } from "../../../src/main/services/notifier"

describe("ElectronNotifier", () => {
  it("creates and shows a notification with the given title and body", async () => {
    const show = vi.fn()
    const create = vi.fn(() => ({ show }))

    const notifier = new ElectronNotifier(create)
    await notifier.notify("Transcription failed", "Could not load model")

    expect(create).toHaveBeenCalledWith({
      title: "Transcription failed",
      body: "Could not load model",
      silent: false,
    })
    expect(show).toHaveBeenCalledOnce()
  })

  it("creates a fresh notification per call", async () => {
    const create = vi.fn(() => ({ show: vi.fn() }))
    const notifier = new ElectronNotifier(create)

    await notifier.notify("a", "b")
    await notifier.notify("c", "d")

    expect(create).toHaveBeenCalledTimes(2)
  })
})
