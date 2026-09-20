import { HotkeyError } from "@opennib/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  GlobalKeyListenerHotkey,
  type KeyEventLike,
  type KeyboardListenerLike,
} from "../../../src/main/services/global-key-hotkey"

class FakeListener implements KeyboardListenerLike {
  private cb: ((event: KeyEventLike) => void) | null = null
  killed = false

  addListener(cb: (event: KeyEventLike) => void): void {
    this.cb = cb
  }

  emit(event: KeyEventLike): void {
    this.cb?.(event)
  }

  kill(): void {
    this.killed = true
  }
}

describe("GlobalKeyListenerHotkey", () => {
  let onPress: ReturnType<typeof vi.fn>
  let onRelease: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onPress = vi.fn()
    onRelease = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function setup() {
    const listener = new FakeListener()
    const factory = vi.fn(() => listener)
    const hotkey = new GlobalKeyListenerHotkey({ factory })
    return { listener, factory, hotkey }
  }

  it("starts the listener and dispatches DOWN/UP for the registered key", async () => {
    const { listener, factory, hotkey } = setup()
    await hotkey.register("RightAlt", { onPress, onRelease })

    expect(factory).toHaveBeenCalledOnce()
    listener.emit({ name: "RIGHT ALT", state: "DOWN" })
    expect(onPress).toHaveBeenCalledOnce()
    listener.emit({ name: "RIGHT ALT", state: "UP" })
    expect(onRelease).toHaveBeenCalledOnce()
  })

  it("ignores events from other keys", async () => {
    const { listener, hotkey } = setup()
    await hotkey.register("RightAlt", { onPress, onRelease })

    listener.emit({ name: "LEFT SHIFT", state: "DOWN" })
    listener.emit({ name: "A", state: "DOWN" })
    expect(onPress).not.toHaveBeenCalled()
  })

  it("ignores events with no name field", async () => {
    const { listener, hotkey } = setup()
    await hotkey.register("RightAlt", { onPress, onRelease })

    listener.emit({ state: "DOWN" })
    expect(onPress).not.toHaveBeenCalled()
  })

  it("rejects unsupported combos", async () => {
    const { hotkey } = setup()
    await expect(hotkey.register("Cmd+Shift+Space", { onPress, onRelease })).rejects.toBeInstanceOf(
      HotkeyError,
    )
  })

  it("refuses double registration", async () => {
    const { hotkey } = setup()
    await hotkey.register("RightAlt", { onPress, onRelease })
    await expect(hotkey.register("ScrollLock", { onPress, onRelease })).rejects.toBeInstanceOf(
      HotkeyError,
    )
  })

  it("unregister kills the listener and clears state", async () => {
    const { listener, hotkey } = setup()
    await hotkey.register("RightAlt", { onPress, onRelease })
    await hotkey.unregister("RightAlt")
    expect(listener.killed).toBe(true)
  })

  it("unregister rejects if combo was never registered", async () => {
    const { hotkey } = setup()
    await expect(hotkey.unregister("RightAlt")).rejects.toBeInstanceOf(HotkeyError)
  })

  it("can re-register after unregister", async () => {
    const { hotkey } = setup()
    await hotkey.register("RightAlt", { onPress, onRelease })
    await hotkey.unregister("RightAlt")
    await expect(hotkey.register("RightAlt", { onPress, onRelease })).resolves.toBeUndefined()
  })

  it("wraps factory failures as HotkeyError", async () => {
    const cause = new Error("native helper missing")
    const factory = vi.fn(() => {
      throw cause
    })
    const hotkey = new GlobalKeyListenerHotkey({ factory })
    try {
      await hotkey.register("RightAlt", { onPress, onRelease })
      throw new Error("expected HotkeyError")
    } catch (err) {
      expect(err).toBeInstanceOf(HotkeyError)
      expect((err as HotkeyError).cause).toBe(cause)
    }
  })

  it("does not crash when a handler throws", async () => {
    const { listener, hotkey } = setup()
    const throwing = vi.fn(() => {
      throw new Error("handler exploded")
    })
    await hotkey.register("RightAlt", { onPress: throwing, onRelease })
    expect(() => listener.emit({ name: "RIGHT ALT", state: "DOWN" })).not.toThrow()
    // After the throw, a release on the same key still dispatches.
    listener.emit({ name: "RIGHT ALT", state: "UP" })
    expect(onRelease).toHaveBeenCalledOnce()
  })
})
