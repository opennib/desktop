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

export interface MacFnHotkeyOptions {
  readonly binaryPath: string
  readonly spawn: SpawnLike
}

const FN_COMBO = "Fn"

/**
 * macOS push-to-talk via the Fn key. The Fn key is not exposed to JS-level
 * libraries, so we run a tiny Swift helper that uses NSEvent's
 * `addGlobalMonitorForEvents` and prints "DOWN" / "UP" to stdout. We parse
 * those lines and dispatch to the provided handlers.
 */
export class MacFnHotkey implements Hotkey {
  private process: ChildProcessLike | null = null
  private registeredCombo: string | null = null

  constructor(private readonly options: MacFnHotkeyOptions) {}

  async register(combo: string, handlers: HotkeyHandlers): Promise<void> {
    if (combo !== FN_COMBO) {
      throw new HotkeyError(`unsupported combo on macOS Fn hotkey: ${combo}`)
    }
    if (this.process !== null) {
      throw new HotkeyError("hotkey already registered")
    }

    let child: ChildProcessLike
    try {
      child = this.options.spawn(this.options.binaryPath)
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
        else if (line === "READY") log.info("fn-key-monitor ready")
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
