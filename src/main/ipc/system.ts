import { ipcMain, shell } from "electron"

import { IPC_CHANNELS } from "../ipc-channels"
import type { KeyboardAccessStatus } from "../services/hotkey"
import type { FsModelManager } from "../services/model-manager"
import { type ElectronPermissions, settingsUrl } from "../services/permissions"
import type { JsonFileSettings } from "../services/settings"

export interface ModelLoadError {
  readonly modelId: string
  readonly message: string
  /**
   * What kind of failure this is, so the renderer can decide whether
   * "re-download" is a sensible CTA.
   *
   * - `"file"`: the model file looks bad (corruption, missing, weight load
   *   failure). Re-download is appropriate.
   * - `"config"`: parameter validation rejected the load (e.g. whisper.cpp's
   *   paired `language` / `detect_language` validators). The file is fine;
   *   re-download would not help.
   * - `"unknown"`: anything else. Surface the raw message, no CTA.
   */
  readonly kind: "file" | "config" | "unknown"
}

export interface SystemIpcDeps {
  readonly permissions: ElectronPermissions
  readonly modelManager: FsModelManager
  readonly settings: JsonFileSettings
  readonly modelLoadError: () => ModelLoadError | null
  readonly keyboardAccess: () => KeyboardAccessStatus
}

export interface SystemStatus {
  readonly microphone: string
  readonly accessibility: string | null
  /** See {@link RunningPipeline.keyboardAccess}. */
  readonly keyboardAccess: KeyboardAccessStatus
  readonly activeModelId: string
  readonly activeModelInstalled: boolean
  readonly loadError: ModelLoadError | null
}

export function registerSystemIpc(deps: SystemIpcDeps): void {
  ipcMain.handle(IPC_CHANNELS.system.status, async () => readyState(deps))

  ipcMain.handle(IPC_CHANNELS.system.requestMicrophone, async () => {
    await deps.permissions.requestMicrophone()
    return readyState(deps)
  })

  ipcMain.handle(IPC_CHANNELS.system.requestAccessibility, async () => {
    if (deps.permissions.requestAccessibility !== undefined) {
      await deps.permissions.requestAccessibility()
    }
    return readyState(deps)
  })

  ipcMain.handle(IPC_CHANNELS.system.openSettings, async (_event, target: unknown) => {
    if (target !== "accessibility" && target !== "microphone" && target !== "input-monitoring") {
      throw new Error(`unsupported settings target: ${String(target)}`)
    }
    // Deep-link directly to the relevant settings pane. Without this the
    // renderer's only option is `requestAccessibility()`, which on macOS only
    // triggers the system prompt the FIRST time it's called — every subsequent
    // click after a denied or dismissed prompt does nothing visible and the
    // user is stuck. Platforms without a matching pane resolve silently; the
    // renderer hides those buttons.
    const url = settingsUrl(process.platform, target)
    if (url !== null) await shell.openExternal(url)
  })
}

async function readyState(deps: SystemIpcDeps): Promise<SystemStatus> {
  const [microphone, accessibility, activeModelInstalled] = await Promise.all([
    deps.permissions.microphone(),
    deps.permissions.accessibility?.() ?? Promise.resolve(null),
    deps.modelManager.isInstalled(deps.settings.whisperModelId()),
  ])
  return {
    microphone,
    accessibility,
    keyboardAccess: deps.keyboardAccess(),
    activeModelId: deps.settings.whisperModelId(),
    activeModelInstalled,
    loadError: deps.modelLoadError(),
  }
}
