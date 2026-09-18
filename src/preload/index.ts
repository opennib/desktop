import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"

import { IPC_CHANNELS } from "../main/ipc-channels"
import type {
  DictionaryEntry,
  HistoryListOptions,
  ModelEntry,
  ModelProgressEvent,
  OpennibPreloadApi,
  PipelineState,
  MainTab,
  SettingsPane,
  SettingsSnapshot,
  SystemStatusSnapshot,
  TranscriptEntry,
} from "../shared/preload-api"

/**
 * Preload API surface exposed to the renderer via `window.opennib`.
 *
 * Kept intentionally tiny — adapters land in the main process and the
 * renderer reaches them through dedicated IPC channels added per
 * feature, not a giant blob exposed up-front.
 *
 * The type contract lives in `../shared/preload-api.ts` so the renderer
 * (compiled as a separate TypeScript project) can consume it without
 * duplicating declarations.
 */
const api: OpennibPreloadApi = {
  version: "0.0.0",
  recorder: {
    onStart(handler: () => void): () => void {
      const wrapped = (_event: IpcRendererEvent) => handler()
      ipcRenderer.on(IPC_CHANNELS.recorder.start, wrapped)
      return () => ipcRenderer.off(IPC_CHANNELS.recorder.start, wrapped)
    },
    onStop(handler: () => void): () => void {
      const wrapped = (_event: IpcRendererEvent) => handler()
      ipcRenderer.on(IPC_CHANNELS.recorder.stop, wrapped)
      return () => ipcRenderer.off(IPC_CHANNELS.recorder.stop, wrapped)
    },
    sendAudio(buffer: ArrayBuffer): void {
      ipcRenderer.send(IPC_CHANNELS.recorder.audio, buffer)
    },
  },
  audio: {
    publishLevel(bins: readonly number[]): void {
      ipcRenderer.send(IPC_CHANNELS.audio.level, bins)
    },
    onLevel(handler: (bins: readonly number[]) => void): () => void {
      const wrapped = (_event: IpcRendererEvent, bins: readonly number[]) => handler(bins)
      ipcRenderer.on(IPC_CHANNELS.audio.level, wrapped)
      return () => ipcRenderer.off(IPC_CHANNELS.audio.level, wrapped)
    },
  },
  state: {
    onChange(handler: (state: PipelineState) => void): () => void {
      const wrapped = (_event: IpcRendererEvent, state: PipelineState) => handler(state)
      ipcRenderer.on(IPC_CHANNELS.state.change, wrapped)
      return () => ipcRenderer.off(IPC_CHANNELS.state.change, wrapped)
    },
  },
  settings: {
    get(): Promise<SettingsSnapshot> {
      return ipcRenderer.invoke(IPC_CHANNELS.settings.get) as Promise<SettingsSnapshot>
    },
    setLanguage(language: string): Promise<SettingsSnapshot> {
      return ipcRenderer.invoke(
        IPC_CHANNELS.settings.setLanguage,
        language,
      ) as Promise<SettingsSnapshot>
    },
    setHotkey(combo: string): Promise<SettingsSnapshot> {
      return ipcRenderer.invoke(IPC_CHANNELS.settings.setHotkey, combo) as Promise<SettingsSnapshot>
    },
    setModel(modelId: string): Promise<SettingsSnapshot> {
      return ipcRenderer.invoke(
        IPC_CHANNELS.settings.setModel,
        modelId,
      ) as Promise<SettingsSnapshot>
    },
    setCleanupEnabled(enabled: boolean): Promise<SettingsSnapshot> {
      return ipcRenderer.invoke(
        IPC_CHANNELS.settings.setCleanupEnabled,
        enabled,
      ) as Promise<SettingsSnapshot>
    },
    setLlmModel(modelId: string | null): Promise<SettingsSnapshot> {
      return ipcRenderer.invoke(
        IPC_CHANNELS.settings.setLlmModel,
        modelId,
      ) as Promise<SettingsSnapshot>
    },
    setEnabled(enabled: boolean): Promise<SettingsSnapshot> {
      return ipcRenderer.invoke(
        IPC_CHANNELS.settings.setEnabled,
        enabled,
      ) as Promise<SettingsSnapshot>
    },
    setSelectedMicId(id: string | null): Promise<SettingsSnapshot> {
      return ipcRenderer.invoke(
        IPC_CHANNELS.settings.setSelectedMicId,
        id,
      ) as Promise<SettingsSnapshot>
    },
    setLaunchAtLogin(value: boolean): Promise<SettingsSnapshot> {
      return ipcRenderer.invoke(
        IPC_CHANNELS.settings.setLaunchAtLogin,
        value,
      ) as Promise<SettingsSnapshot>
    },
    setShowInDock(value: boolean): Promise<SettingsSnapshot> {
      return ipcRenderer.invoke(
        IPC_CHANNELS.settings.setShowInDock,
        value,
      ) as Promise<SettingsSnapshot>
    },
    setHotkeyMode(mode: "hold" | "tap" | "tap-twice"): Promise<SettingsSnapshot> {
      return ipcRenderer.invoke(
        IPC_CHANNELS.settings.setHotkeyMode,
        mode,
      ) as Promise<SettingsSnapshot>
    },
    setDictationSounds(value: boolean): Promise<SettingsSnapshot> {
      return ipcRenderer.invoke(
        IPC_CHANNELS.settings.setDictationSounds,
        value,
      ) as Promise<SettingsSnapshot>
    },
    setNotificationSounds(value: boolean): Promise<SettingsSnapshot> {
      return ipcRenderer.invoke(
        IPC_CHANNELS.settings.setNotificationSounds,
        value,
      ) as Promise<SettingsSnapshot>
    },
    setFirstRunHintShown(value: boolean): Promise<SettingsSnapshot> {
      return ipcRenderer.invoke(
        IPC_CHANNELS.settings.setFirstRunHintShown,
        value,
      ) as Promise<SettingsSnapshot>
    },
    onChange(handler: (snapshot: SettingsSnapshot) => void): () => void {
      const wrapped = (_event: IpcRendererEvent, snapshot: SettingsSnapshot) => handler(snapshot)
      ipcRenderer.on(IPC_CHANNELS.settings.change, wrapped)
      return () => ipcRenderer.off(IPC_CHANNELS.settings.change, wrapped)
    },
  },
  models: {
    list(): Promise<readonly ModelEntry[]> {
      return ipcRenderer.invoke(IPC_CHANNELS.models.list) as Promise<readonly ModelEntry[]>
    },
    download(modelId: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.models.download, modelId) as Promise<void>
    },
    remove(modelId: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.models.remove, modelId) as Promise<void>
    },
    onProgress(handler: (event: ModelProgressEvent) => void): () => void {
      const wrapped = (_event: IpcRendererEvent, payload: ModelProgressEvent) => handler(payload)
      ipcRenderer.on(IPC_CHANNELS.models.progress, wrapped)
      return () => ipcRenderer.off(IPC_CHANNELS.models.progress, wrapped)
    },
  },
  history: {
    list(options?: HistoryListOptions): Promise<readonly TranscriptEntry[]> {
      return ipcRenderer.invoke(IPC_CHANNELS.history.list, options ?? {}) as Promise<
        readonly TranscriptEntry[]
      >
    },
    clear(): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.history.clear) as Promise<void>
    },
  },
  dictionary: {
    list(): Promise<readonly DictionaryEntry[]> {
      return ipcRenderer.invoke(IPC_CHANNELS.dictionary.list) as Promise<readonly DictionaryEntry[]>
    },
    add(entry: DictionaryEntry): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.dictionary.add, entry) as Promise<void>
    },
    remove(id: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.dictionary.remove, id) as Promise<void>
    },
    clear(): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.dictionary.clear) as Promise<void>
    },
  },
  system: {
    status(): Promise<SystemStatusSnapshot> {
      return ipcRenderer.invoke(IPC_CHANNELS.system.status) as Promise<SystemStatusSnapshot>
    },
    requestMicrophone(): Promise<SystemStatusSnapshot> {
      return ipcRenderer.invoke(
        IPC_CHANNELS.system.requestMicrophone,
      ) as Promise<SystemStatusSnapshot>
    },
    requestAccessibility(): Promise<SystemStatusSnapshot> {
      return ipcRenderer.invoke(
        IPC_CHANNELS.system.requestAccessibility,
      ) as Promise<SystemStatusSnapshot>
    },
    openSettings(target: SettingsPane): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.system.openSettings, target) as Promise<void>
    },
  },
  tray: {
    onShow(handler: () => void): () => void {
      const wrapped = (_event: IpcRendererEvent) => handler()
      ipcRenderer.on(IPC_CHANNELS.tray.show, wrapped)
      return () => ipcRenderer.off(IPC_CHANNELS.tray.show, wrapped)
    },
    hide(): void {
      ipcRenderer.send(IPC_CHANNELS.tray.hide)
    },
    quit(): void {
      ipcRenderer.send(IPC_CHANNELS.tray.quit)
    },
    showSettings(tab?: MainTab): void {
      ipcRenderer.send(IPC_CHANNELS.tray.showSettings, tab)
    },
    insertLast(): Promise<{ readonly inserted: boolean }> {
      return ipcRenderer.invoke(IPC_CHANNELS.tray.insertLast) as Promise<{
        readonly inserted: boolean
      }>
    },
  },
  onboarding: {
    complete(): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.onboarding.complete) as Promise<void>
    },
    reset(): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.onboarding.reset) as Promise<void>
    },
    setTryMode(enabled: boolean): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.onboarding.setTryMode, enabled) as Promise<void>
    },
    setStep(step: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.onboarding.setStep, step) as Promise<void>
    },
    onTranscript(handler: (text: string) => void): () => void {
      const wrapped = (_event: IpcRendererEvent, text: string) => handler(text)
      ipcRenderer.on(IPC_CHANNELS.onboarding.transcript, wrapped)
      return () => ipcRenderer.off(IPC_CHANNELS.onboarding.transcript, wrapped)
    },
  },
  nav: {
    onShowTab(handler: (tab: string) => void): () => void {
      const wrapped = (_event: IpcRendererEvent, tab: string) => handler(tab)
      ipcRenderer.on(IPC_CHANNELS.main.showTab, wrapped)
      return () => ipcRenderer.off(IPC_CHANNELS.main.showTab, wrapped)
    },
  },
}

contextBridge.exposeInMainWorld("opennib", api)

export type { OpennibPreloadApi } from "../shared/preload-api"
