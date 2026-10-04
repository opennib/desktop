import { HotkeyError, type Hotkey, type HotkeyHandlers, log } from "@opennib/core"

/**
 * Subset of node-global-key-listener's `IGlobalKeyEvent` we care about. Pulled
 * out so the adapter is testable without spawning the bundled native helper.
 */
export interface KeyEventLike {
  readonly name?: string
  readonly state: "DOWN" | "UP"
}

export interface KeyboardListenerLike {
  /** node-global-key-listener returns a promise that rejects if its helper fails to spawn. */
  addListener(cb: (event: KeyEventLike) => void): void | Promise<void>
  kill(): void
}

export type KeyboardListenerFactory = () => KeyboardListenerLike

export interface GlobalKeyListenerHotkeyOptions {
  readonly factory: KeyboardListenerFactory
}

/**
 * Map our combo identifiers to the uppercase key names node-global-key-listener
 * emits. Single-key push-to-talk only for v0.2 — chord support can come later
 * when settings expose hotkey customization.
 */
const COMBO_KEY_NAMES: Record<string, readonly string[]> = {
  RightAlt: ["RIGHT ALT"],
  LeftAlt: ["LEFT ALT"],
  RightCtrl: ["RIGHT CTRL"],
  ScrollLock: ["SCROLL LOCK"],
  F8: ["F8"],
  F9: ["F9"],
}

/**
 * Push-to-talk hotkey for Windows and Linux via node-global-key-listener.
 * The package ships a small native helper binary per platform that streams
 * key events over stdio — no Electron-ABI rebuild required.
 *
 * macOS uses a separate Fn-specific adapter (MacFnHotkey) because Apple's
 * Fn key isn't surfaced through the standard global keyboard hook APIs.
 */
export class GlobalKeyListenerHotkey implements Hotkey {
  private listener: KeyboardListenerLike | null = null
  private registeredCombo: string | null = null

  constructor(private readonly options: GlobalKeyListenerHotkeyOptions) {}

  async register(combo: string, handlers: HotkeyHandlers): Promise<void> {
    const keyNames = COMBO_KEY_NAMES[combo]
    if (keyNames === undefined) {
      throw new HotkeyError(
        `unsupported combo: ${combo} (allowed: ${Object.keys(COMBO_KEY_NAMES).join(", ")})`,
      )
    }
    if (this.listener !== null) {
      throw new HotkeyError("hotkey already registered")
    }

    let listener: KeyboardListenerLike
    try {
      listener = this.options.factory()
    } catch (cause) {
      throw new HotkeyError("failed to start global key listener", cause)
    }
    this.listener = listener
    this.registeredCombo = combo

    try {
      await listener.addListener((event) => {
        if (event.name === undefined || !keyNames.includes(event.name)) return
        try {
          if (event.state === "DOWN") handlers.onPress()
          else if (event.state === "UP") handlers.onRelease()
        } catch (err) {
          // Handler errors must not kill the listener thread.
          log.error("hotkey handler threw", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })
    } catch (cause) {
      this.listener = null
      this.registeredCombo = null
      throw new HotkeyError("global key listener helper failed to start", cause)
    }
  }

  async unregister(combo: string): Promise<void> {
    if (combo !== this.registeredCombo) {
      throw new HotkeyError(`combo not registered: ${combo}`)
    }
    if (this.listener !== null) {
      this.listener.kill()
      this.listener = null
    }
    this.registeredCombo = null
  }
}
