/**
 * IPC channel names shared by main, preload, and (via the preload bridge)
 * renderer. Consolidated here so a renamed channel is a single-file change.
 */
export const IPC_CHANNELS = {
  recorder: {
    start: "recorder:start",
    stop: "recorder:stop",
    audio: "recorder:audio",
  },
  audio: {
    /**
     * Renderer→main publish of recent FFT bin levels (0..1) used to drive
     * the HUD waveform; main fans out to the HUD window. Same channel name
     * on both legs to keep the bridge trivial.
     */
    level: "audio:level",
  },
  state: {
    change: "state:change",
  },
  settings: {
    get: "settings:get",
    setLanguage: "settings:set-language",
    setHotkey: "settings:set-hotkey",
    setModel: "settings:set-model",
    setCleanupEnabled: "settings:set-cleanup-enabled",
    setLlmModel: "settings:set-llm-model",
    setEnabled: "settings:set-enabled",
    setSelectedMicId: "settings:set-selected-mic-id",
    setLaunchAtLogin: "settings:set-launch-at-login",
    setShowInDock: "settings:set-show-in-dock",
    setHotkeyMode: "settings:set-hotkey-mode",
    setDictationSounds: "settings:set-dictation-sounds",
    setNotificationSounds: "settings:set-notification-sounds",
    setFirstRunHintShown: "settings:set-first-run-hint-shown",
    change: "settings:change",
  },
  models: {
    list: "models:list",
    download: "models:download",
    remove: "models:remove",
    progress: "models:progress",
  },
  history: {
    list: "history:list",
    clear: "history:clear",
  },
  dictionary: {
    list: "dictionary:list",
    add: "dictionary:add",
    remove: "dictionary:remove",
    clear: "dictionary:clear",
  },
  system: {
    status: "system:status",
    requestMicrophone: "system:request-microphone",
    requestAccessibility: "system:request-accessibility",
    openSettings: "system:open-settings",
  },
  tray: {
    show: "tray:show",
    hide: "tray:hide",
    quit: "tray:quit",
    showSettings: "tray:show-settings",
    insertLast: "tray:insert-last",
  },
  onboarding: {
    complete: "onboarding:complete",
    reset: "onboarding:reset",
    setTryMode: "onboarding:set-try-mode",
    transcript: "onboarding:transcript",
  },
} as const
