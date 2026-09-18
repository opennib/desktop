// Shared type contract for the preload bridge exposed at `window.opennib`.
//
// The desktop package compiles as two separate TypeScript projects
// (tsconfig.node.json for main+preload, tsconfig.web.json for renderer), so
// this file is included by both — keep it free of runtime imports and of any
// API that wouldn't run in both the Node and DOM lib targets.

export type PipelineState = "idle" | "recording" | "processing"

export type HotkeyMode = "hold" | "tap" | "tap-twice"

export interface SettingsSnapshot {
  readonly whisperModelId: string
  readonly language: string
  readonly hotkey: string
  readonly hotkeyMode: HotkeyMode
  readonly cleanupEnabled: boolean
  readonly llmModelId: string | null
  readonly onboardingCompleted: boolean
  readonly enabled: boolean
  readonly selectedMicId: string | null
  readonly launchAtLogin: boolean
  readonly showInDock: boolean
  readonly dictationSounds: boolean
  readonly notificationSounds: boolean
  readonly firstRunHintShown: boolean
  readonly onboardingStep: string
}

export type ModelKindId = "whisper" | "llm"

export interface ModelEntry {
  readonly id: string
  readonly kind: ModelKindId
  readonly displayName: string
  readonly approxSizeBytes: number
  readonly multilingual?: boolean
  readonly installed: boolean
  readonly active: boolean
  readonly downloading: boolean
}

export interface ModelProgressEvent {
  readonly modelId: string
  readonly percent: number
  readonly state: "downloading" | "completed" | "failed"
  readonly error?: string
}

export interface TranscriptEntry {
  readonly id: string
  readonly createdAt: number
  readonly text: string
  readonly language: string
  readonly durationMs: number
  readonly app?: string
}

export interface HistoryListOptions {
  readonly limit?: number
}

export interface DictionaryEntry {
  readonly id: string
  readonly term: string
  readonly replacement?: string
  readonly createdAt: number
}

export type SettingsPane = "accessibility" | "microphone" | "input-monitoring"

export type MainTab = "history" | "dictionary" | "models" | "general" | "dictation"

export interface SystemStatusSnapshot {
  readonly microphone: "granted" | "denied" | "undetermined"
  readonly accessibility: "granted" | "denied" | "undetermined" | null
  /** Whether the hotkey helper may see keystrokes ("waiting" = allow it in Input Monitoring). */
  readonly keyboardAccess: "unknown" | "waiting" | "granted"
  readonly activeModelId: string
  readonly activeModelInstalled: boolean
  readonly loadError: {
    readonly modelId: string
    readonly message: string
    readonly kind: "file" | "config" | "unknown"
  } | null
}

export interface OpennibRecorderApi {
  onStart(handler: () => void): () => void
  onStop(handler: () => void): () => void
  sendAudio(buffer: ArrayBuffer): void
}

export interface OpennibAudioApi {
  /**
   * Publish a frame of normalised (0..1) FFT bin levels from the active
   * recorder. Main forwards to the HUD window so the waveform reflects
   * what the mic actually hears.
   */
  publishLevel(bins: readonly number[]): void
  /** HUD-side subscription to per-frame audio levels. */
  onLevel(handler: (bins: readonly number[]) => void): () => void
}

export interface OpennibStateApi {
  onChange(handler: (state: PipelineState) => void): () => void
}

export interface OpennibSettingsApi {
  get(): Promise<SettingsSnapshot>
  setLanguage(language: string): Promise<SettingsSnapshot>
  setHotkey(combo: string): Promise<SettingsSnapshot>
  setModel(modelId: string): Promise<SettingsSnapshot>
  setCleanupEnabled(enabled: boolean): Promise<SettingsSnapshot>
  setLlmModel(modelId: string | null): Promise<SettingsSnapshot>
  setEnabled(enabled: boolean): Promise<SettingsSnapshot>
  setSelectedMicId(id: string | null): Promise<SettingsSnapshot>
  setLaunchAtLogin(value: boolean): Promise<SettingsSnapshot>
  setShowInDock(value: boolean): Promise<SettingsSnapshot>
  setHotkeyMode(mode: HotkeyMode): Promise<SettingsSnapshot>
  setDictationSounds(value: boolean): Promise<SettingsSnapshot>
  setNotificationSounds(value: boolean): Promise<SettingsSnapshot>
  setFirstRunHintShown(value: boolean): Promise<SettingsSnapshot>
  onChange(handler: (snapshot: SettingsSnapshot) => void): () => void
}

export interface OpennibModelsApi {
  list(): Promise<readonly ModelEntry[]>
  download(modelId: string): Promise<void>
  remove(modelId: string): Promise<void>
  onProgress(handler: (event: ModelProgressEvent) => void): () => void
}

export interface OpennibHistoryApi {
  list(options?: HistoryListOptions): Promise<readonly TranscriptEntry[]>
  clear(): Promise<void>
}

export interface OpennibDictionaryApi {
  list(): Promise<readonly DictionaryEntry[]>
  add(entry: DictionaryEntry): Promise<void>
  remove(id: string): Promise<void>
  clear(): Promise<void>
}

export interface OpennibSystemApi {
  status(): Promise<SystemStatusSnapshot>
  requestMicrophone(): Promise<SystemStatusSnapshot>
  requestAccessibility(): Promise<SystemStatusSnapshot>
  openSettings(target: SettingsPane): Promise<void>
}

export interface OpennibOnboardingApi {
  complete(): Promise<void>
  /**
   * Re-runs the first-launch walkthrough. Persists onboardingCompleted=false
   * and surfaces the onboarding window again. Triggered from General settings.
   */
  reset(): Promise<void>
  /**
   * Toggle "try mode" while the onboarding window is on the Try-it-out step.
   * When enabled, transcripts produced by the dictation pipeline are routed
   * to {@link OpennibOnboardingApi.onTranscript} instead of being pasted into
   * the focused app — onboarding can't paste system-wide without confusing
   * the user (they're following along with our window, not typing in another
   * app yet).
   */
  setTryMode(enabled: boolean): Promise<void>
  /** Persist the step the user is on so a relaunch resumes there. */
  setStep(step: string): Promise<void>
  /** Fires once per transcript while try-mode is enabled. */
  onTranscript(handler: (text: string) => void): () => void
}

export interface OpennibTrayApi {
  onShow(handler: () => void): () => void
  hide(): void
  quit(): void
  /** Bring up the main window, optionally on a specific tab. */
  showSettings(tab?: MainTab): void
  insertLast(): Promise<{ readonly inserted: boolean }>
}

export interface OpennibPreloadApi {
  readonly version: string
  readonly recorder: OpennibRecorderApi
  readonly audio: OpennibAudioApi
  readonly state: OpennibStateApi
  readonly settings: OpennibSettingsApi
  readonly models: OpennibModelsApi
  readonly history: OpennibHistoryApi
  readonly dictionary: OpennibDictionaryApi
  readonly system: OpennibSystemApi
  readonly tray: OpennibTrayApi
  readonly onboarding: OpennibOnboardingApi
  readonly nav: OpennibNavApi
}

export interface OpennibNavApi {
  /** main→renderer request to select a tab in the main window. */
  onShowTab(handler: (tab: string) => void): () => void
}
