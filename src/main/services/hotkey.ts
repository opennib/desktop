import { HotkeyError, type Hotkey, type HotkeyHandlers, log } from "@opennib/core"

/**
 * Minimal subset of `node:child_process`'s ChildProcess we depend on, so the
 * adapter is testable without spawning a real process.
 */
export interface ChildProcessLike {
  readonly stdout: { on(event: "data", cb: (chunk: Buffer) => void): void } | null
  readonly stderr: { on(event: "data", cb: (chunk: Buffer) => void): void } | null
  on(event: "exit", listener: (code: number | null) => void): this
  on(event: "error", listener: (err: Error) => void): this
  kill(): boolean
}

export type SpawnLike = (path: string, args?: readonly string[]) => ChildProcessLike

/**
 * Keyboard-access state reported by the helper. "waiting" means macOS has not
 * granted it Input Monitoring / Accessibility yet, so Fn presses cannot be
 * seen; "granted" once the monitor is live.
 */
export type KeyboardAccessState = "waiting" | "granted"

/** {@link KeyboardAccessState} plus "unknown" for adapters that don't report. */
export type KeyboardAccessStatus = KeyboardAccessState | "unknown"

export interface MacFnHotkeyOptions {
  readonly binaryPath: string
  readonly spawn: SpawnLike
  readonly onKeyboardAccess?: (state: KeyboardAccessState) => void
}

/**
 * Combos the Swift helper can watch. All modifiers (they surface as
 * flagsChanged, which is also how Fn arrives), chosen so nothing a user holds
 * while typing is on the list: fn and Left Control on the left half of the
 * keyboard, Right Option and Right Command on the right. See
 * native/fn-key-monitor.swift.
 */
export const MAC_HELPER_COMBOS: readonly string[] = ["Fn", "LeftCtrl", "RightAlt", "RightCmd"]

/**
 * macOS push-to-talk via the Swift key helper. Fn is not exposed to JS-level
 * libraries at all, and the other presets are modifiers, so the helper watches
 * the chosen key with NSEvent's `addGlobalMonitorForEvents` and prints
 * "DOWN" / "UP" to stdout. We parse those lines and dispatch to the handlers.
 */
export class MacFnHotkey implements Hotkey {
  private process: ChildProcessLike | null = null
  private registeredCombo: string | null = null

  constructor(private readonly options: MacFnHotkeyOptions) {}

  async register(combo: string, handlers: HotkeyHandlers): Promise<void> {
    if (!MAC_HELPER_COMBOS.includes(combo)) {
      throw new HotkeyError(
        `unsupported combo for the macOS key helper: ${combo} (allowed: ${MAC_HELPER_COMBOS.join(", ")})`,
      )
    }
    if (this.process !== null) {
      throw new HotkeyError("hotkey already registered")
    }

    let child: ChildProcessLike
    try {
      child = this.options.spawn(this.options.binaryPath, [combo])
    } catch (cause) {
      throw new HotkeyError("failed to spawn fn-key-monitor", cause)
    }
    this.process = child
    this.registeredCombo = combo

    let pending = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8")
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""
      for (const raw of lines) {
        const line = raw.trim()
        if (line === "DOWN") handlers.onPress()
        else if (line === "UP") handlers.onRelease()
        else if (line === "READY") {
          log.info("fn-key-monitor ready")
          this.options.onKeyboardAccess?.("granted")
        } else if (line === "WAITING_PERMISSION") {
          log.warn("fn-key-monitor waiting for Input Monitoring permission")
          this.options.onKeyboardAccess?.("waiting")
        }
      }
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      log.warn("fn-key-monitor stderr", { line: chunk.toString("utf8").trim() })
    })

    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        log.error("fn-key-monitor exited unexpectedly", { code })
      }
      this.process = null
      this.registeredCombo = null
    })

    child.on("error", (err) => {
      log.error("fn-key-monitor errored", { error: err.message })
    })
  }

  async unregister(combo: string): Promise<void> {
    if (combo !== this.registeredCombo) {
      throw new HotkeyError(`combo not registered: ${combo}`)
    }
    if (this.process !== null) {
      this.process.kill()
      this.process = null
    }
    this.registeredCombo = null
  }
}
