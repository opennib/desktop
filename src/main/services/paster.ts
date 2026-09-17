import { PasterError, type Paster } from "@opennib/core"

export interface ClipboardLike {
  writeText(text: string): void
}

export interface ExecBinary {
  (path: string): Promise<void>
}

/**
 * Exit code `paste-helper` uses when macOS refused it Accessibility trust.
 * The helper is a separate binary, so its grant is separate from the app's;
 * see the header comment in native/paste-helper.swift.
 */
export const PASTE_HELPER_EXIT_NOT_TRUSTED = 2

export const PASTE_HELPER_NOT_TRUSTED_MESSAGE =
  "opennib's paste helper is not allowed to control the computer. " +
  "Enable it under System Settings → Privacy & Security → Accessibility, then try again."

export interface MacPasterOptions {
  readonly clipboard: ClipboardLike
  readonly pasteHelperPath: string
  readonly exec: ExecBinary
  /**
   * Delay between writing to the clipboard and posting Cmd+V. macOS needs a
   * tick or two for the pasteboard change to settle before the synthetic
   * keystroke fires; the POC settled on 50ms.
   */
  readonly clipboardSettleMs?: number
}

const DEFAULT_SETTLE_MS = 50

/** Node's execFile error carries the child's exit status as `code`. */
function exitCodeOf(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null) return undefined
  const code = (cause as { code?: unknown }).code
  return typeof code === "number" ? code : undefined
}

/**
 * Paster on macOS: write to the system clipboard, wait for it to settle, then
 * invoke a tiny native Swift helper that posts a Cmd+V CGEvent. This avoids
 * nut-js's Apple Silicon stability issues and the AppleScript permission
 * popup. The helper binary path is injected so packaging code decides where
 * the file lives at runtime.
 */
export class MacPaster implements Paster {
  constructor(private readonly options: MacPasterOptions) {}

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
      await this.options.exec(this.options.pasteHelperPath)
    } catch (cause) {
      if (exitCodeOf(cause) === PASTE_HELPER_EXIT_NOT_TRUSTED) {
        throw new PasterError(PASTE_HELPER_NOT_TRUSTED_MESSAGE, cause)
      }
      throw new PasterError("paste-helper execution failed", cause)
    }
  }
}
