import { ipcMain } from "electron"

import { isLlmModelId, isSupportedLanguage, isWhisperModelId } from "@opennib/core"

import { IPC_CHANNELS } from "../ipc-channels"
import type { HotkeyMode, JsonFileSettings } from "../services/settings"

/**
 * Combos the desktop hotkey adapters can actually register. Keep in sync with
 * `MacFnHotkey` ("Fn") and `GlobalKeyListenerHotkey`'s key map.
 */
const ALLOWED_HOTKEYS = new Set<string>([
  "Fn",
  "RightAlt",
  "LeftAlt",
  "RightCtrl",
  "ScrollLock",
  "F8",
  "F9",
])

export function registerSettingsIpc(settings: JsonFileSettings): void {
  ipcMain.handle(IPC_CHANNELS.settings.get, () => settings.appSnapshot())

  ipcMain.handle(IPC_CHANNELS.settings.setLanguage, async (_event, language: unknown) => {
    if (typeof language !== "string" || !isSupportedLanguage(language)) {
      throw new Error(`unsupported language tag: ${String(language)}`)
    }
    await settings.setLanguage(language)
    return settings.appSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.settings.setHotkey, async (_event, combo: unknown) => {
    if (typeof combo !== "string" || !ALLOWED_HOTKEYS.has(combo)) {
      throw new Error(
        `unsupported hotkey combo: ${String(combo)} (allowed: ${[...ALLOWED_HOTKEYS].join(", ")})`,
      )
    }
    await settings.setHotkey(combo)
    return settings.appSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.settings.setModel, async (_event, modelId: unknown) => {
    if (typeof modelId !== "string" || !isWhisperModelId(modelId)) {
      throw new Error(`unsupported whisper model id: ${String(modelId)}`)
    }
    await settings.setWhisperModelId(modelId)
    return settings.appSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.settings.setCleanupEnabled, async (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") {
      throw new Error(`cleanupEnabled must be a boolean, got ${typeof enabled}`)
    }
    await settings.setCleanupEnabled(enabled)
    return settings.appSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.settings.setLlmModel, async (_event, modelId: unknown) => {
    if (modelId === null) {
      await settings.setLlmModelId(null)
      return settings.appSnapshot()
    }
    if (typeof modelId !== "string" || !isLlmModelId(modelId)) {
      throw new Error(`unsupported llm model id: ${String(modelId)}`)
    }
    await settings.setLlmModelId(modelId)
    return settings.appSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.settings.setEnabled, async (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") {
      throw new Error(`enabled must be a boolean, got ${typeof enabled}`)
    }
    await settings.setEnabled(enabled)
    return settings.appSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.settings.setSelectedMicId, async (_event, id: unknown) => {
    if (id !== null && typeof id !== "string") {
      throw new Error(`selectedMicId must be a string or null, got ${typeof id}`)
    }
    await settings.setSelectedMicId(id)
    return settings.appSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.settings.setLaunchAtLogin, async (_event, value: unknown) => {
    if (typeof value !== "boolean") {
      throw new Error(`launchAtLogin must be a boolean, got ${typeof value}`)
    }
    await settings.setLaunchAtLogin(value)
    return settings.appSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.settings.setShowInDock, async (_event, value: unknown) => {
    if (typeof value !== "boolean") {
      throw new Error(`showInDock must be a boolean, got ${typeof value}`)
    }
    await settings.setShowInDock(value)
    return settings.appSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.settings.setHotkeyMode, async (_event, mode: unknown) => {
    if (typeof mode !== "string" || !HOTKEY_MODES.has(mode)) {
      throw new Error(`unsupported hotkey mode: ${String(mode)}`)
    }
    await settings.setHotkeyMode(mode as HotkeyMode)
    return settings.appSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.settings.setDictationSounds, async (_event, value: unknown) => {
    if (typeof value !== "boolean") {
      throw new Error(`dictationSounds must be a boolean, got ${typeof value}`)
    }
    await settings.setDictationSounds(value)
    return settings.appSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.settings.setNotificationSounds, async (_event, value: unknown) => {
    if (typeof value !== "boolean") {
      throw new Error(`notificationSounds must be a boolean, got ${typeof value}`)
    }
    await settings.setNotificationSounds(value)
    return settings.appSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.settings.setFirstRunHintShown, async (_event, value: unknown) => {
    if (typeof value !== "boolean") {
      throw new Error(`firstRunHintShown must be a boolean, got ${typeof value}`)
    }
    await settings.setFirstRunHintShown(value)
    return settings.appSnapshot()
  })
}

const HOTKEY_MODES = new Set<string>(["hold", "tap", "tap-twice"])
