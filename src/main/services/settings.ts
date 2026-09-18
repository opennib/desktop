import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import {
  DEFAULT_SETTINGS_SNAPSHOT,
  StorageError,
  log,
  parseSettingsSnapshot,
  type LanguageTag,
  type Settings,
  type SettingsSnapshot,
} from "@opennib/core"

/**
 * How the push-to-talk hotkey behaves. See {@link HostSettingsSnapshot.hotkeyMode}.
 *
 * `"hold"` is the historical default and the only mode wired in v0.1–v0.5;
 * `"tap"` and `"tap-twice"` were added in v0.8 alongside the redesigned
 * Dictation preferences panel. Desktop-only — mobile dictation triggers off
 * the keyboard extension / IME tap, not a system hotkey.
 */
export type HotkeyMode = "hold" | "tap" | "tap-twice"

/**
 * Default push-to-talk combo when no setting is stored. macOS uses the Fn key
 * via the native helper; Windows/Linux default to RightAlt. The composition
 * root overrides this per platform via `JsonFileSettingsOptions.defaultHotkey`
 * before the first `load()`.
 */
export const DEFAULT_HOTKEY = "Fn"

/**
 * Desktop-only host settings. These are the concepts core doesn't own — the
 * push-to-talk hotkey, tray toggles, onboarding flags, and OS integration
 * (launch-at-login, dock). They persist in the SAME JSON blob as the core
 * dictation slice so existing installs migrate for free.
 */
export interface HostSettingsSnapshot {
  /**
   * Push-to-talk hotkey combo. Platform-specific defaults:
   *   - macOS: "Fn"
   *   - Windows/Linux: "RightAlt"
   * Values that the bundled hotkey adapters understand:
   *   macOS helper: "Fn" · "LeftCtrl" · "RightAlt" · "RightCmd"
   *   node-global-key-listener (Win/Linux): "RightAlt" · "LeftAlt" ·
   *   "RightCtrl" · "ScrollLock" · "F8" · "F9".
   */
  readonly hotkey: string
  /**
   * How the hotkey triggers recording. "hold" = press to start, release to
   * end (the historical default, no accidental capture). "tap" = single
   * press toggles. "tap-twice" = double-tap to start, single press to stop.
   */
  readonly hotkeyMode: HotkeyMode
  /**
   * Whether the user has finished the first-launch onboarding flow.
   * Stored in settings so the flag survives reinstalls of the same
   * user-data-dir while still resetting on a clean wipe.
   */
  readonly onboardingCompleted: boolean
  /**
   * Last onboarding step the user reached ("welcome", "acc", "mic", "model",
   * "lang", "try", "done"), so a relaunch mid-flow resumes there. Ignored
   * once `onboardingCompleted` is true.
   */
  readonly onboardingStep: string
  /**
   * Whether the global push-to-talk hotkey is currently active. The OS hook
   * stays registered either way — toggling this just gates `beginCycle` /
   * `endCycle` so the user can mute the listener from the tray without
   * tearing down the hotkey backend.
   */
  readonly enabled: boolean
  /**
   * Preferred input device id from `navigator.mediaDevices.enumerateDevices()`.
   * `null` means "follow the OS default" — the recorder will omit the
   * `deviceId` constraint in that case.
   */
  readonly selectedMicId: string | null
  /**
   * Whether the host app should auto-launch on system login. Wired to
   * `app.setLoginItemSettings({ openAtLogin })` on macOS and Windows; a no-op
   * on Linux distros without a registry path. Off by default so a fresh
   * install never auto-runs without explicit consent.
   */
  readonly launchAtLogin: boolean
  /**
   * Whether opennib shows a dock/taskbar icon. macOS hides the dock entry by
   * default so the menu-bar app never becomes frontmost during paste; turning
   * this on calls `app.dock.show()` and surfaces the icon. No-op on
   * Windows/Linux today (we don't render a taskbar icon there either way).
   */
  readonly showInDock: boolean
  /**
   * Play a quiet tick when recording starts/ends. Off by default — most
   * users find recording status sufficiently indicated by the HUD pulse.
   */
  readonly dictationSounds: boolean
  /**
   * Play an alert sound when opennib surfaces an error (missing mic, paste
   * blocked, etc.). Off by default.
   */
  readonly notificationSounds: boolean
  /**
   * Whether the first-run "Hold fn to dictate" overlay has been shown after
   * the user finished onboarding. Persisted so we don't replay it.
   */
  readonly firstRunHintShown: boolean
}

/**
 * Combined settings view — the dictation slice core owns plus the desktop
 * host slice. This is the wire/IPC payload shape and the on-disk blob shape;
 * keeping them identical means the renderer and existing settings files need
 * no migration.
 */
export type AppSettingsSnapshot = SettingsSnapshot & HostSettingsSnapshot

const HOTKEY_MODES: ReadonlySet<HotkeyMode> = new Set(["hold", "tap", "tap-twice"])

export const DEFAULT_HOST_SETTINGS_SNAPSHOT: HostSettingsSnapshot = {
  hotkey: DEFAULT_HOTKEY,
  hotkeyMode: "hold",
  onboardingCompleted: false,
  onboardingStep: "welcome",
  enabled: true,
  selectedMicId: null,
  launchAtLogin: false,
  showInDock: false,
  dictationSounds: false,
  notificationSounds: false,
  firstRunHintShown: false,
}

/**
 * Parse the host slice from arbitrary input (the same object core's
 * `parseSettingsSnapshot` reads). Missing fields, wrong types, and empty
 * strings all fall back to the canonical default for that field — mirroring
 * core's tolerant style so a partial or legacy blob loads without throwing.
 */
export function parseHostSettingsSnapshot(raw: unknown): HostSettingsSnapshot {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_HOST_SETTINGS_SNAPSHOT
  }
  const partial = raw as Partial<HostSettingsSnapshot>
  return {
    hotkey:
      typeof partial.hotkey === "string" && partial.hotkey.length > 0
        ? partial.hotkey
        : DEFAULT_HOST_SETTINGS_SNAPSHOT.hotkey,
    hotkeyMode:
      typeof partial.hotkeyMode === "string" && HOTKEY_MODES.has(partial.hotkeyMode as HotkeyMode)
        ? (partial.hotkeyMode as HotkeyMode)
        : DEFAULT_HOST_SETTINGS_SNAPSHOT.hotkeyMode,
    onboardingCompleted:
      typeof partial.onboardingCompleted === "boolean"
        ? partial.onboardingCompleted
        : DEFAULT_HOST_SETTINGS_SNAPSHOT.onboardingCompleted,
    onboardingStep:
      typeof partial.onboardingStep === "string" && partial.onboardingStep.length > 0
        ? partial.onboardingStep
        : DEFAULT_HOST_SETTINGS_SNAPSHOT.onboardingStep,
    enabled:
      typeof partial.enabled === "boolean"
        ? partial.enabled
        : DEFAULT_HOST_SETTINGS_SNAPSHOT.enabled,
    selectedMicId:
      typeof partial.selectedMicId === "string" && partial.selectedMicId.length > 0
        ? partial.selectedMicId
        : null,
    launchAtLogin:
      typeof partial.launchAtLogin === "boolean"
        ? partial.launchAtLogin
        : DEFAULT_HOST_SETTINGS_SNAPSHOT.launchAtLogin,
    showInDock:
      typeof partial.showInDock === "boolean"
        ? partial.showInDock
        : DEFAULT_HOST_SETTINGS_SNAPSHOT.showInDock,
    dictationSounds:
      typeof partial.dictationSounds === "boolean"
        ? partial.dictationSounds
        : DEFAULT_HOST_SETTINGS_SNAPSHOT.dictationSounds,
    notificationSounds:
      typeof partial.notificationSounds === "boolean"
        ? partial.notificationSounds
        : DEFAULT_HOST_SETTINGS_SNAPSHOT.notificationSounds,
    firstRunHintShown:
      typeof partial.firstRunHintShown === "boolean"
        ? partial.firstRunHintShown
        : DEFAULT_HOST_SETTINGS_SNAPSHOT.firstRunHintShown,
  }
}

export interface JsonFileSettingsOptions {
  readonly filePath: string
  /**
   * Platform-appropriate default hotkey. Used only when no settings file exists
   * yet — once a value is stored, it wins. macOS → "Fn", others → "RightAlt".
   */
  readonly defaultHotkey?: string
}

/**
 * Tiny JSON-backed settings store. We don't pull in `electron-store` because
 * it would also bring an opinion about defaults, schemas, and migrations we
 * don't want yet.
 *
 * Implements core's dictation `Settings` and layers the desktop host slice on
 * top. Both persist to ONE JSON blob under `storage.baseDirectory()`, so an
 * existing `settings.json` loads unchanged. `appSnapshot()` returns the
 * combined view for IPC.
 *
 * `load()` must be awaited once at boot before any synchronous getter is
 * called; the in-memory snapshot stays authoritative thereafter and writes
 * persist via an atomic rename through a `.partial` sibling so a power-cut
 * mid-write can't yield a half-truncated JSON file.
 */
export class JsonFileSettings implements Settings {
  private core: SettingsSnapshot = DEFAULT_SETTINGS_SNAPSHOT
  private host: HostSettingsSnapshot = DEFAULT_HOST_SETTINGS_SNAPSHOT
  private coreListeners = new Set<(s: SettingsSnapshot) => void>()
  private appListeners = new Set<(s: AppSettingsSnapshot) => void>()
  private loaded = false

  constructor(private readonly options: JsonFileSettingsOptions) {
    if (options.defaultHotkey !== undefined && options.defaultHotkey.length > 0) {
      this.host = { ...DEFAULT_HOST_SETTINGS_SNAPSHOT, hotkey: options.defaultHotkey }
    }
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.options.filePath, "utf8")
      const parsed: unknown = JSON.parse(raw)
      this.core = parseSettingsSnapshot(parsed)
      // Preserve the platform default hotkey when the stored blob has no
      // hotkey (legacy file predating the field). `parseHostSettingsSnapshot`
      // falls back to DEFAULT_HOTKEY; re-apply the constructor's override.
      const host = parseHostSettingsSnapshot(parsed)
      this.host =
        typeof (parsed as Partial<HostSettingsSnapshot>)?.hotkey === "string"
          ? host
          : { ...host, hotkey: this.host.hotkey }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        // First launch — leave defaults in place.
      } else if (err instanceof SyntaxError) {
        log.warn("settings file unparseable, falling back to defaults", {
          error: err.message,
        })
      } else {
        // Anything else is a real I/O problem; surface a typed error so the
        // composition root can decide whether to abort startup.
        throw new StorageError(`failed to load settings: ${describeError(err)}`, err)
      }
    }
    this.loaded = true
  }

  whisperModelId(): string {
    return this.core.whisperModelId
  }

  language(): LanguageTag {
    return this.core.language
  }

  cleanupEnabled(): boolean {
    return this.core.cleanupEnabled
  }

  llmModelId(): string | null {
    return this.core.llmModelId
  }

  hotkey(): string {
    return this.host.hotkey
  }

  hotkeyMode(): HotkeyMode {
    return this.host.hotkeyMode
  }

  onboardingCompleted(): boolean {
    return this.host.onboardingCompleted
  }

  enabled(): boolean {
    return this.host.enabled
  }

  selectedMicId(): string | null {
    return this.host.selectedMicId
  }

  launchAtLogin(): boolean {
    return this.host.launchAtLogin
  }

  showInDock(): boolean {
    return this.host.showInDock
  }

  dictationSounds(): boolean {
    return this.host.dictationSounds
  }

  notificationSounds(): boolean {
    return this.host.notificationSounds
  }

  firstRunHintShown(): boolean {
    return this.host.firstRunHintShown
  }

  snapshot(): SettingsSnapshot {
    return this.core
  }

  /** Combined dictation + host view. This is the IPC / on-disk shape. */
  appSnapshot(): AppSettingsSnapshot {
    return { ...this.core, ...this.host }
  }

  async setWhisperModelId(id: string): Promise<void> {
    await this.updateCore({ whisperModelId: id })
  }

  async setLanguage(language: LanguageTag): Promise<void> {
    await this.updateCore({ language })
  }

  async setCleanupEnabled(enabled: boolean): Promise<void> {
    await this.updateCore({ cleanupEnabled: enabled })
  }

  async setLlmModelId(id: string | null): Promise<void> {
    await this.updateCore({ llmModelId: id })
  }

  async setHotkey(combo: string): Promise<void> {
    await this.updateHost({ hotkey: combo })
  }

  async setHotkeyMode(mode: HotkeyMode): Promise<void> {
    await this.updateHost({ hotkeyMode: mode })
  }

  async setOnboardingCompleted(value: boolean): Promise<void> {
    await this.updateHost({ onboardingCompleted: value })
  }

  onboardingStep(): string {
    return this.host.onboardingStep
  }

  async setOnboardingStep(step: string): Promise<void> {
    await this.updateHost({ onboardingStep: step })
  }

  async setEnabled(value: boolean): Promise<void> {
    await this.updateHost({ enabled: value })
  }

  async setSelectedMicId(id: string | null): Promise<void> {
    await this.updateHost({ selectedMicId: id })
  }

  async setLaunchAtLogin(value: boolean): Promise<void> {
    await this.updateHost({ launchAtLogin: value })
  }

  async setShowInDock(value: boolean): Promise<void> {
    await this.updateHost({ showInDock: value })
  }

  async setDictationSounds(value: boolean): Promise<void> {
    await this.updateHost({ dictationSounds: value })
  }

  async setNotificationSounds(value: boolean): Promise<void> {
    await this.updateHost({ notificationSounds: value })
  }

  async setFirstRunHintShown(value: boolean): Promise<void> {
    await this.updateHost({ firstRunHintShown: value })
  }

  onChange(handler: (snapshot: SettingsSnapshot) => void): () => void {
    this.coreListeners.add(handler)
    return () => {
      this.coreListeners.delete(handler)
    }
  }

  /**
   * Subscribe to any change (dictation or host). Returns an unsubscribe
   * function. Desktop main uses this for IPC broadcast + startup-preference
   * application, which react to host fields core's `onChange` doesn't carry.
   */
  onAppChange(handler: (snapshot: AppSettingsSnapshot) => void): () => void {
    this.appListeners.add(handler)
    return () => {
      this.appListeners.delete(handler)
    }
  }

  private async updateCore(partial: Partial<SettingsSnapshot>): Promise<void> {
    if (!this.loaded) {
      throw new StorageError("settings used before load()")
    }
    const next: SettingsSnapshot = { ...this.core, ...partial }
    if (
      next.whisperModelId === this.core.whisperModelId &&
      next.language === this.core.language &&
      next.cleanupEnabled === this.core.cleanupEnabled &&
      next.llmModelId === this.core.llmModelId
    ) {
      return
    }
    this.core = next
    await this.persist()
    this.notify()
  }

  private async updateHost(partial: Partial<HostSettingsSnapshot>): Promise<void> {
    if (!this.loaded) {
      throw new StorageError("settings used before load()")
    }
    const next: HostSettingsSnapshot = { ...this.host, ...partial }
    if (
      next.hotkey === this.host.hotkey &&
      next.hotkeyMode === this.host.hotkeyMode &&
      next.onboardingCompleted === this.host.onboardingCompleted &&
      next.onboardingStep === this.host.onboardingStep &&
      next.enabled === this.host.enabled &&
      next.selectedMicId === this.host.selectedMicId &&
      next.launchAtLogin === this.host.launchAtLogin &&
      next.showInDock === this.host.showInDock &&
      next.dictationSounds === this.host.dictationSounds &&
      next.notificationSounds === this.host.notificationSounds &&
      next.firstRunHintShown === this.host.firstRunHintShown
    ) {
      return
    }
    this.host = next
    await this.persist()
    this.notify()
  }

  private notify(): void {
    const core = this.core
    for (const listener of this.coreListeners) {
      try {
        listener(core)
      } catch (err) {
        log.error("settings listener threw", { error: describeError(err) })
      }
    }
    const app = this.appSnapshot()
    for (const listener of this.appListeners) {
      try {
        listener(app)
      } catch (err) {
        log.error("settings listener threw", { error: describeError(err) })
      }
    }
  }

  private async persist(): Promise<void> {
    const target = this.options.filePath
    const partial = `${target}.partial`
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(partial, JSON.stringify(this.appSnapshot(), null, 2), "utf8")
      await rename(partial, target)
    } catch (err) {
      throw new StorageError(`failed to persist settings: ${describeError(err)}`, err)
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
