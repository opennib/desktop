import { PasterError, type Paster } from "@opennib/core"

export interface ClipboardLike {
  writeText(text: string): void
}

export type SpawnPaste = () => Promise<void>

export interface SystemPasterOptions {
  readonly clipboard: ClipboardLike
  readonly spawnPaste: SpawnPaste
  /**
   * Delay between writing to the clipboard and dispatching the paste
   * keystroke. Windows + most Linux compositors only need a small settle so
   * the clipboard owner change is observed before SendKeys / xdotool fires.
   */
  readonly clipboardSettleMs?: number
}

const DEFAULT_SETTLE_MS = 30

/**
 * Cross-platform paste for Windows and Linux: write to the system clipboard,
 * wait for the change to settle, then synthesize Ctrl+V via a platform-native
 * tool (PowerShell SendKeys on Windows, xdotool / wtype on Linux). The
 * platform-specific spawn is injected so this class stays a thin orchestrator
 * and the OS detection lives in the wiring code.
 *
 * macOS uses MacPaster instead because the project ships a signed Swift
 * helper that posts CGEvents reliably on Apple Silicon, which is more
 * stable than third-party Node automation libraries.
 */
export class SystemPaster implements Paster {
  constructor(private readonly options: SystemPasterOptions) {}

  async paste(text: string): Promise<void> {
    try {
      this.options.clipboard.writeText(text)
    } catch (cause) {
      throw new PasterError("clipboard write failed", cause)
    }

    const settleMs = this.options.clipboardSettleMs ?? DEFAULT_SETTLE_MS
    if (settleMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, settleMs))
    }

    try {
      await this.options.spawnPaste()
    } catch (cause) {
      throw new PasterError("paste keystroke failed", cause)
    }
  }
}
