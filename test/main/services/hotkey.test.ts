import { EventEmitter } from "node:events"

import { HotkeyError } from "@opennib/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { MacFnHotkey, type ChildProcessLike } from "../../../src/main/services/hotkey"

class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly stdout = new EventEmitter() as unknown as ChildProcessLike["stdout"]
  readonly stderr = new EventEmitter() as unknown as ChildProcessLike["stderr"]
  killed = false

  emitStdout(text: string) {
    ;(this.stdout as unknown as EventEmitter).emit("data", Buffer.from(text, "utf8"))
  }

  emitStderr(text: string) {
    ;(this.stderr as unknown as EventEmitter).emit("data", Buffer.from(text, "utf8"))
  }

  emitExit(code: number | null) {
    this.emit("exit", code)
  }

  kill(): boolean {
    this.killed = true
    this.emitExit(0)
    return true
  }
}

describe("MacFnHotkey", () => {
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
    const child = new FakeChild()
    const spawn = vi.fn(() => child)
    const hotkey = new MacFnHotkey({ binaryPath: "/path/fn-key-monitor", spawn })
    return { child, spawn, hotkey }
  }

  it("spawns the binary and emits press/release on DOWN/UP", async () => {
    const { child, spawn, hotkey } = setup()
    await hotkey.register("Fn", { onPress, onRelease })

    expect(spawn).toHaveBeenCalledWith("/path/fn-key-monitor")
    child.emitStdout("READY\nDOWN\n")
    expect(onPress).toHaveBeenCalledOnce()
    child.emitStdout("UP\n")
    expect(onRelease).toHaveBeenCalledOnce()
  })

  it("buffers partial lines across data chunks", async () => {
    const { child, hotkey } = setup()
    await hotkey.register("Fn", { onPress, onRelease })

    child.emitStdout("DO")
    expect(onPress).not.toHaveBeenCalled()
    child.emitStdout("WN\nUP")
    expect(onPress).toHaveBeenCalledOnce()
    expect(onRelease).not.toHaveBeenCalled()
    child.emitStdout("\n")
    expect(onRelease).toHaveBeenCalledOnce()
  })

  it("ignores unknown stdout lines", async () => {
    const { child, hotkey } = setup()
    await hotkey.register("Fn", { onPress, onRelease })

    child.emitStdout("READY\nGARBAGE\n\n")
    expect(onPress).not.toHaveBeenCalled()
    expect(onRelease).not.toHaveBeenCalled()
  })

  it("rejects combos other than Fn", async () => {
    const { hotkey } = setup()
    await expect(hotkey.register("Cmd+Shift+Space", { onPress, onRelease })).rejects.toBeInstanceOf(
      HotkeyError,
    )
  })

  it("refuses double registration", async () => {
    const { hotkey } = setup()
    await hotkey.register("Fn", { onPress, onRelease })
    await expect(hotkey.register("Fn", { onPress, onRelease })).rejects.toBeInstanceOf(HotkeyError)
  })

  it("unregister kills the child process", async () => {
    const { child, hotkey } = setup()
    await hotkey.register("Fn", { onPress, onRelease })
    await hotkey.unregister("Fn")
    expect(child.killed).toBe(true)
  })

  it("unregister rejects if combo was never registered", async () => {
    const { hotkey } = setup()
    await expect(hotkey.unregister("Fn")).rejects.toBeInstanceOf(HotkeyError)
  })

  it("can re-register after unregister", async () => {
    const { hotkey } = setup()
    await hotkey.register("Fn", { onPress, onRelease })
    await hotkey.unregister("Fn")
    await expect(hotkey.register("Fn", { onPress, onRelease })).resolves.toBeUndefined()
  })

  it("wraps spawn failures as HotkeyError", async () => {
    const cause = new Error("ENOENT")
    const spawn = vi.fn(() => {
      throw cause
    })
    const hotkey = new MacFnHotkey({ binaryPath: "/missing", spawn })
    try {
      await hotkey.register("Fn", { onPress, onRelease })
      throw new Error("expected HotkeyError")
    } catch (err) {
      expect(err).toBeInstanceOf(HotkeyError)
      expect((err as HotkeyError).cause).toBe(cause)
    }
  })

  it("clears state when the child exits unexpectedly", async () => {
    const { child, hotkey } = setup()
    await hotkey.register("Fn", { onPress, onRelease })
    child.emitExit(1)
    // After exit, register again should succeed without an "already registered" error.
    await expect(hotkey.register("Fn", { onPress, onRelease })).resolves.toBeUndefined()
  })
})
