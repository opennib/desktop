import { randomUUID } from "node:crypto"

import { BrowserWindow, ipcMain } from "electron"

import { DictationPipeline, log, type Hotkey, type PipelineState } from "@opennib/core"

import { errorMessage } from "./error-message"
import { createHotkey } from "./platform-adapters"
import type { PreparedServices } from "./prepare-services"
import { ElectronRecorderTransport } from "./services/electron-recorder-transport"
import type { KeyboardAccessStatus } from "./services/hotkey"
import { IpcRecorder } from "./services/recorder"

export interface RunningPipeline {
  readonly pipeline: DictationPipeline
  readonly services: PreparedServices
  /** Unregister the active push-to-talk hotkey + detach settings listeners. */
  readonly stop: () => Promise<void>
  /**
   * Whether the OS lets the hotkey helper see keystrokes. "waiting" means the
   * user still has to allow it in Input Monitoring; "unknown" for adapters
   * that cannot tell.
   */
  readonly keyboardAccess: () => KeyboardAccessStatus
}

export interface StartPipelineOptions {
  readonly services: PreparedServices
  readonly window: BrowserWindow
  readonly onStateChange: (state: PipelineState) => void
}

export async function startPipeline(
  options: StartPipelineOptions,
): Promise<RunningPipeline | null> {
  const { services, window, onStateChange } = options

  const micState = await services.permissions.microphone()
  if (micState !== "granted") {
    log.info("requesting microphone permission", { current: micState })
    const next = await services.permissions.requestMicrophone()
    if (next !== "granted") {
      log.warn("microphone permission not granted", { state: next })
    }
  }

  const accState = await services.permissions.accessibility?.()
  if (accState !== "granted") {
    log.info("accessibility permission required for paste-helper", { current: accState })
  }

  const transport = new ElectronRecorderTransport({
    webContents: window.webContents,
    ipcMain,
  })
  const recorder = new IpcRecorder({ transport })

  const pipeline = new DictationPipeline({
    recorder,
    transcriber: services.transcriber,
    modelManager: services.modelManager,
    cleaner: () => services.cleaner.current(),
    dictionary: services.dictionary,
    paster: services.paster,
    history: services.history,
    notifier: services.notifier,
    settings: services.settings,
    idFactory: randomUUID,
    onStateChange,
  })

  // Hotkey lifecycle: read the user's chosen combo from settings, register
  // it via the appropriate adapter (MacFnHotkey vs GlobalKeyListenerHotkey),
  // and re-bind on the fly when settings change so "Change shortcut" in the
  // Dictation panel takes effect without a relaunch.
  //
  // Hotkey-mode dispatch happens here in the handler, not in the adapter, so
  // a mode change ("hold" → "tap-twice") takes effect on the very next key
  // event without re-registering the hotkey.
  const DOUBLE_TAP_WINDOW_MS = 400
  let lastReleaseTime = 0

  const handlers = {
    onPress: () => {
      if (!services.settings.enabled()) return
      if (services.settings.hotkeyMode() === "hold") {
        void pipeline.beginCycle()
      }
      // Tap modes act on release, not press, so they ignore this event.
    },
    onRelease: () => {
      if (!services.settings.enabled()) return
      const mode = services.settings.hotkeyMode()
      if (mode === "hold") {
        void pipeline.endCycle()
        return
      }
      // Tap modes: each release is the actionable event.
      const state = pipeline.currentState()
      if (state === "recording") {
        // A press during recording always stops, in both tap and tap-twice.
        // Otherwise the user can't end the cycle without an extra trigger.
        void pipeline.endCycle()
        lastReleaseTime = 0
        return
      }
      if (mode === "tap") {
        void pipeline.beginCycle()
        return
      }
      // tap-twice: require a second release inside the window to start.
      const now = Date.now()
      if (now - lastReleaseTime < DOUBLE_TAP_WINDOW_MS) {
        void pipeline.beginCycle()
        lastReleaseTime = 0
      } else {
        lastReleaseTime = now
      }
    },
  }

  let keyboardAccess: KeyboardAccessStatus = "unknown"
  const hotkeyOptions = {
    onKeyboardAccess: (state: KeyboardAccessStatus) => {
      keyboardAccess = state
    },
  }

  let activeCombo = services.settings.hotkey()
  let activeHotkey: Hotkey
  try {
    activeHotkey = createHotkey(activeCombo, hotkeyOptions)
    await activeHotkey.register(activeCombo, handlers)
  } catch (err) {
    log.error("failed to register push-to-talk hotkey", {
      combo: activeCombo,
      error: errorMessage(err),
    })
    return null
  }

  const unsubscribeHotkeyChange = services.settings.onAppChange((snap) => {
    if (snap.hotkey === activeCombo) return
    const previousCombo = activeCombo
    const nextCombo = snap.hotkey
    void (async () => {
      try {
        await activeHotkey.unregister(previousCombo)
      } catch (err) {
        log.warn("hotkey unregister failed during swap", {
          combo: previousCombo,
          error: errorMessage(err),
        })
      }
      try {
        keyboardAccess = "unknown"
        activeHotkey = createHotkey(nextCombo, hotkeyOptions)
        await activeHotkey.register(nextCombo, handlers)
        activeCombo = nextCombo
        log.info("hotkey swapped", { from: previousCombo, to: nextCombo })
      } catch (err) {
        // New combo failed to register — attempt to restore the previous one
        // so the user is never left without a working push-to-talk key.
        log.error("hotkey swap failed, restoring previous combo", {
          attempted: nextCombo,
          error: errorMessage(err),
        })
        try {
          activeHotkey = createHotkey(previousCombo, hotkeyOptions)
          await activeHotkey.register(previousCombo, handlers)
          activeCombo = previousCombo
        } catch (restoreErr) {
          log.error("hotkey restore also failed; push-to-talk is now dead", {
            error: errorMessage(restoreErr),
          })
        }
      }
    })()
  })

  log.info("dictation pipeline ready", {
    modelId: services.settings.whisperModelId(),
    language: services.settings.language(),
    hotkey: activeCombo,
    cleaner: services.cleaner.current() !== null,
  })

  return {
    pipeline,
    services,
    stop: async () => {
      unsubscribeHotkeyChange()
      await activeHotkey.unregister(activeCombo)
    },
    keyboardAccess: () => keyboardAccess,
  }
}
