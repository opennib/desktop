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

/** Combos the Windows PowerShell watcher polls. See native/win-key-monitor.ps1. */
export const WIN_HELPER_COMBOS: readonly string[] = [
  "LeftCtrl",
  "RightCtrl",
  "LeftAlt",
  "RightAlt",
  "ScrollLock",
  "F8",
  "F9",
]

export interface HelperCommand {
  readonly path: string
  readonly args: readonly string[]
}

export interface HelperHotkeyOptions {
  /** Helper name for log lines, e.g. "fn-key-monitor". */
  readonly name: string
  readonly allowedCombos: readonly string[]
  readonly command: (combo: string) => HelperCommand
  readonly spawn: SpawnLike
  readonly onKeyboardAccess?: (state: KeyboardAccessState) => void
}

/**
 * Push-to-talk via a helper process that watches one key and prints "DOWN" /
 * "UP" lines to stdout ("READY" once live, "WAITING_PERMISSION" while the OS
 * withholds keyboard access). The macOS Swift helper and the Windows
 * PowerShell watcher both speak this protocol.
 */
export class HelperHotkey implements Hotkey {
  private process: ChildProcessLike | null = null
  private registeredCombo: string | null = null

  constructor(private readonly options: HelperHotkeyOptions) {}

  async register(combo: string, handlers: HotkeyHandlers): Promise<void> {
    const { name, allowedCombos } = this.options
    if (!allowedCombos.includes(combo)) {
      throw new HotkeyError(
        `unsupported combo for ${name}: ${combo} (allowed: ${allowedCombos.join(", ")})`,
      )
    }
    if (this.process !== null) {
      throw new HotkeyError("hotkey already registered")
    }

    let child: ChildProcessLike
    try {
      const { path, args } = this.options.command(combo)
      child = this.options.spawn(path, args)
    } catch (cause) {
      throw new HotkeyError(`failed to spawn ${name}`, cause)
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
          log.info(`${name} ready`)
          this.options.onKeyboardAccess?.("granted")
        } else if (line === "WAITING_PERMISSION") {
          log.warn(`${name} waiting for Input Monitoring permission`)
          this.options.onKeyboardAccess?.("waiting")
        }
      }
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      log.warn(`${name} stderr`, { line: chunk.toString("utf8").trim() })
    })

    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        log.error(`${name} exited unexpectedly`, { code })
      }
      this.process = null
      this.registeredCombo = null
    })

    child.on("error", (err) => {
      log.error(`${name} errored`, { error: err.message })
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

/**
 * macOS push-to-talk via the Swift key helper. Fn is not exposed to JS-level
 * libraries at all, and the other presets are modifiers, so the helper watches
 * the chosen key with NSEvent's `addGlobalMonitorForEvents`.
 */
export class MacFnHotkey extends HelperHotkey {
  constructor(options: MacFnHotkeyOptions) {
    super({
      name: "fn-key-monitor",
      allowedCombos: MAC_HELPER_COMBOS,
      command: (combo) => ({ path: options.binaryPath, args: [combo] }),
      spawn: options.spawn,
      ...(options.onKeyboardAccess !== undefined
        ? { onKeyboardAccess: options.onKeyboardAccess }
        : {}),
    })
  }
}

export interface WindowsKeyHotkeyOptions {
  /** Path to native/win-key-monitor.ps1. */
  readonly scriptPath: string
  readonly spawn: SpawnLike
  /** Our own pid; the watcher exits when this process is gone. */
  readonly parentPid: number
}

/**
 * Windows push-to-talk via a PowerShell script that polls GetAsyncKeyState for
 * the one chosen key. A low-level keyboard hook is the textbook keylogger
 * shape, and Windows Defender quarantines unsigned hook helpers (it removed
 * node-global-key-listener's WinKeyServer.exe as Trojan:Win32/KeyLogger on a
 * stock machine). Polling a single key is hook-free and ships as readable text.
 */
export class WindowsKeyHotkey extends HelperHotkey {
  constructor(options: WindowsKeyHotkeyOptions) {
    super({
      name: "win-key-monitor",
      allowedCombos: WIN_HELPER_COMBOS,
      command: (combo) => ({
        path: "powershell.exe",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-WindowStyle",
          "Hidden",
          "-File",
          options.scriptPath,
          combo,
          String(options.parentPid),
        ],
      }),
      spawn: options.spawn,
    })
  }
}
