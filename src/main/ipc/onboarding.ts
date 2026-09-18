import { BrowserWindow, ipcMain } from "electron"

import { IPC_CHANNELS } from "../ipc-channels"
import type { JsonFileSettings } from "../services/settings"

export interface OnboardingIpcDeps {
  readonly settings: JsonFileSettings
  /**
   * Lazily resolves the active onboarding window. The window is created
   * conditionally during first-launch and closed after `complete`, so we
   * cannot bind a reference at registration time.
   */
  readonly getWindow: () => BrowserWindow | undefined
  /**
   * Invoked after the flag is persisted. The main process uses this to swap
   * windows — close the onboarding window and bring up the main UI + tray
   * popover hint. Kept as a callback so this module stays free of window
   * orchestration.
   */
  readonly onComplete: () => void
  /**
   * Invoked after the user clicks "Reset onboarding" in General settings.
   * Flips the persisted flag to false; the host is expected to (re)create the
   * onboarding window and hide the main shell so the flow replays from step 1.
   */
  readonly onReset: () => void
  /**
   * Invoked when the renderer enters Try-it-out. The host starts the
   * dictation pipeline (hotkey helper + recorder) here rather than at boot,
   * so the OS permission prompts it triggers appear on the screen that
   * explains them, not on top of step 1.
   */
  readonly onTryModeEnter: () => void
}

let tryMode = false
let resolveWindow: (() => BrowserWindow | undefined) | undefined

export function registerOnboardingIpc(deps: OnboardingIpcDeps): void {
  resolveWindow = deps.getWindow

  ipcMain.handle(IPC_CHANNELS.onboarding.complete, async () => {
    tryMode = false
    await deps.settings.setOnboardingCompleted(true)
    deps.onComplete()
  })

  ipcMain.handle(IPC_CHANNELS.onboarding.reset, async () => {
    tryMode = false
    await deps.settings.setOnboardingCompleted(false)
    await deps.settings.setOnboardingStep("welcome")
    deps.onReset()
  })

  ipcMain.handle(IPC_CHANNELS.onboarding.setTryMode, async (_event, enabled: unknown) => {
    tryMode = Boolean(enabled)
    if (tryMode) deps.onTryModeEnter()
  })

  // Persist progress so quitting mid-flow (macOS asks for that after some
  // permission grants) resumes on the same step instead of step 1.
  ipcMain.handle(IPC_CHANNELS.onboarding.setStep, async (_event, step: unknown) => {
    if (typeof step !== "string" || step.length === 0) {
      throw new Error(`onboarding step must be a non-empty string, got ${typeof step}`)
    }
    await deps.settings.setOnboardingStep(step)
  })
}

/**
 * True while the onboarding window has Try-it-out active and has asked the
 * pipeline to route transcripts to it instead of pasting into the focused
 * app. Read by the try-mode paster wrapper.
 */
export function isOnboardingTryMode(): boolean {
  return tryMode
}

/**
 * Forward the transcript to the onboarding window. Returns `true` when the
 * window swallowed it (try-mode on, window alive) so the caller can skip the
 * real paste; returns `false` otherwise.
 */
export function emitOnboardingTranscript(text: string): boolean {
  if (!tryMode) return false
  const win = resolveWindow?.()
  if (win === undefined || win.isDestroyed()) return false
  win.webContents.send(IPC_CHANNELS.onboarding.transcript, text)
  return true
}
