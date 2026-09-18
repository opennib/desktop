import { SUPPORTED_LANGUAGES } from "@opennib/core"

import type {
  DictionaryEntry,
  ModelEntry,
  ModelProgressEvent,
  OpennibPreloadApi,
  PipelineState,
  SettingsSnapshot,
  SystemStatusSnapshot,
  TranscriptEntry,
} from "../shared/preload-api"

import { installRecorder } from "./recorder"

declare global {
  interface Window {
    readonly opennib: OpennibPreloadApi
  }
}

// ─── State labels ────────────────────────────────────────────────────
// Map pipeline state → sidebar status pill text. The design uses single
// words: "Ready / Listening / Transcribing", set against the colored dot.
const STATE_LABELS: Record<PipelineState, string> = {
  idle: "Ready",
  recording: "Listening",
  processing: "Transcribing",
}

// ─── DOM handles ─────────────────────────────────────────────────────

const indicator = document.getElementById("indicator")
const statusText = document.getElementById("status")
const navHistoryCount = document.getElementById("nav-history-count")
const navDictionaryCount = document.getElementById("nav-dictionary-count")

// History
const historyGroups = document.getElementById("history-groups")
const historyEmpty = document.getElementById("history-empty")
const historyClearBtn = document.getElementById("history-clear") as HTMLButtonElement | null
const historySearchInput = document.getElementById("history-search") as HTMLInputElement | null

// Dictionary
const dictionaryList = document.getElementById("dictionary-list")
const dictionaryEmpty = document.getElementById("dictionary-empty")
const dictionarySearchInput = document.getElementById(
  "dictionary-search",
) as HTMLInputElement | null
const dictionaryAddBtn = document.getElementById("dictionary-add") as HTMLButtonElement | null
const dictionaryForm = document.getElementById("dictionary-form") as HTMLFormElement | null
const dictionaryCancelBtn = document.getElementById("dictionary-cancel") as HTMLButtonElement | null
const dictionaryTermInput = document.getElementById("dictionary-term") as HTMLInputElement | null
const dictionaryReplacementInput = document.getElementById(
  "dictionary-replacement",
) as HTMLInputElement | null

// Models
const whisperModelList = document.getElementById("whisper-model-list")

// General
const permissionsList = document.getElementById("permissions-list")
const launchAtLoginToggle = document.getElementById(
  "toggle-launch-at-login",
) as HTMLButtonElement | null
const showInDockToggle = document.getElementById("toggle-show-in-dock") as HTMLButtonElement | null
const rowShowInDock = document.getElementById("row-show-in-dock")
const resetOnboardingBtn = document.getElementById("reset-onboarding") as HTMLButtonElement | null

// Dictation
const hotkeyDisplay = document.getElementById("hotkey-display")
const hotkeyChangeBtn = document.getElementById("hotkey-change") as HTMLButtonElement | null
const hotkeyModal = document.getElementById("hotkey-modal")
const hotkeyModalOptions = document.getElementById("hotkey-modal-options")
const hotkeyModalCancelBtn = document.getElementById(
  "hotkey-modal-cancel",
) as HTMLButtonElement | null
const hotkeyModalSaveBtn = document.getElementById("hotkey-modal-save") as HTMLButtonElement | null
const hotkeyCapture = document.getElementById("hotkey-capture")
const hotkeyCaptureState = document.getElementById("hotkey-capture-state")
const hotkeyCaptureKey = document.getElementById("hotkey-capture-key")
const hotkeyCaptureHint = document.getElementById("hotkey-capture-hint")
const modePicker = document.getElementById("mode-picker")
const dictationSoundsToggle = document.getElementById(
  "toggle-dictation-sounds",
) as HTMLButtonElement | null
const notificationSoundsToggle = document.getElementById(
  "toggle-notification-sounds",
) as HTMLButtonElement | null
const micSelect = document.getElementById("mic-select") as HTMLSelectElement | null
const languageSelect = document.getElementById("language") as HTMLSelectElement | null

// First-run hint
const firstRunHint = document.getElementById("first-run-hint")
const firstRunKeyLabel = document.getElementById("first-run-key-label")
const firstRunDismissBtn = document.getElementById("first-run-dismiss") as HTMLButtonElement | null
const firstRunChangeBtn = document.getElementById("first-run-change") as HTMLButtonElement | null

// Readiness banner (still surfaces blocking issues at the top)
const readinessBanner = document.getElementById("readiness")

// ─── Local state ─────────────────────────────────────────────────────

let currentSnapshot: SettingsSnapshot | null = null
let lastModelEntries: readonly ModelEntry[] = []
let micDevices: MediaDeviceInfo[] = []
let historyEntries: readonly TranscriptEntry[] = []
let dictionaryEntries: readonly DictionaryEntry[] = []
let historyQuery = ""
let dictionaryQuery = ""
let lastPipelineState: PipelineState = "idle"
const modelProgress = new Map<
  string,
  { percent: number; state: ModelProgressEvent["state"]; error?: string }
>()
const HISTORY_LIMIT = 50

// ─── Sidebar status pill ─────────────────────────────────────────────

function renderState(state: PipelineState): void {
  if (indicator !== null) indicator.dataset["state"] = state
  if (statusText !== null) statusText.textContent = STATE_LABELS[state]
}

// ─── Routing ─────────────────────────────────────────────────────────

const TAB_STORAGE_KEY = "opennib.activeTab"
const VALID_TABS = ["history", "dictionary", "models", "general", "dictation"] as const
type TabId = (typeof VALID_TABS)[number]

function isTabId(value: string | null): value is TabId {
  return value !== null && (VALID_TABS as readonly string[]).includes(value)
}

function selectTab(tab: TabId): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    btn.setAttribute("aria-selected", btn.dataset["tab"] === tab ? "true" : "false")
  }
  for (const panel of document.querySelectorAll<HTMLElement>("[data-tab-panel]")) {
    panel.hidden = panel.dataset["tabPanel"] !== tab
  }
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tab)
  } catch {
    // localStorage can throw in some configurations (private mode, quota); the
    // tab still works for the current session, just won't persist.
  }
}

for (const btn of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  btn.addEventListener("click", () => {
    const tab = btn.dataset["tab"]
    if (isTabId(tab ?? null)) selectTab(tab as TabId)
  })
}

const storedTab = (() => {
  try {
    return localStorage.getItem(TAB_STORAGE_KEY)
  } catch {
    return null
  }
})()
selectTab(isTabId(storedTab) ? storedTab : "history")
window.opennib.nav.onShowTab((tab) => {
  if (isTabId(tab)) selectTab(tab)
})

// ─── Cmd/Ctrl-F focuses search input on the active panel ─────────────

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "f") {
    const activeBtn = document.querySelector<HTMLButtonElement>('.tab[aria-selected="true"]')
    const tab = activeBtn?.dataset["tab"]
    if (tab === "history" && historySearchInput !== null) {
      e.preventDefault()
      historySearchInput.focus()
      historySearchInput.select()
    } else if (tab === "dictionary" && dictionarySearchInput !== null) {
      e.preventDefault()
      dictionarySearchInput.focus()
      dictionarySearchInput.select()
    }
  }
})

// ─── Language picker ─────────────────────────────────────────────────

function renderLanguagePicker(currentTag: string): void {
  if (languageSelect === null) return
  languageSelect.innerHTML = ""
  for (const lang of SUPPORTED_LANGUAGES) {
    const option = document.createElement("option")
    option.value = lang.tag
    option.textContent =
      lang.tag === "auto" || lang.displayName === lang.nativeName
        ? lang.displayName
        : `${lang.displayName} (${lang.nativeName})`
    if (lang.tag === currentTag) option.selected = true
    languageSelect.appendChild(option)
  }
  languageSelect.disabled = false
}

if (languageSelect !== null) {
  languageSelect.addEventListener("change", () => {
    const value = languageSelect.value
    void window.opennib.settings.setLanguage(value).catch((err) => {
      console.error("setLanguage failed", err)
    })
  })
}

// ─── Microphone picker ───────────────────────────────────────────────

async function loadMicDevices(): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    // Chromium synthesises two aliases (`default`, `communications`) on top of
    // the real devices. We expose "System default" as a virtual row already,
    // so the aliases would just duplicate the same physical device.
    micDevices = devices.filter(
      (d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications",
    )
  } catch {
    // enumerateDevices can fail before mic permission is granted; user can
    // still pick System default. Permissions banner will prompt them.
  }
}

function renderMicPicker(currentId: string | null): void {
  if (micSelect === null) return
  micSelect.innerHTML = ""
  const def = document.createElement("option")
  def.value = ""
  def.textContent = "System default"
  micSelect.appendChild(def)
  for (const d of micDevices) {
    const opt = document.createElement("option")
    opt.value = d.deviceId
    opt.textContent = d.label !== "" ? d.label : "Microphone"
    micSelect.appendChild(opt)
  }
  micSelect.value = currentId ?? ""
  micSelect.disabled = false
}

if (micSelect !== null) {
  micSelect.addEventListener("change", () => {
    const value = micSelect.value
    void window.opennib.settings.setSelectedMicId(value === "" ? null : value).catch((err) => {
      console.error("setSelectedMicId failed", err)
    })
  })
}

// ─── Hotkey display + picker modal (Dictation panel) ─────────────────

const HOTKEY_LABELS: Readonly<Record<string, string>> = {
  Fn: "Hold fn",
  LeftCtrl: "Hold Left Control",
  RightAlt: "Hold Right Option",
  LeftAlt: "Hold Left Alt",
  RightCtrl: "Hold Right Ctrl",
  RightCmd: "Hold Right Command",
  ScrollLock: "Hold Scroll Lock",
  F8: "Hold F8",
  F9: "Hold F9",
}

const HOTKEY_KEY_LABELS: Readonly<Record<string, string>> = {
  Fn: "fn",
  LeftCtrl: "Left ⌃",
  RightAlt: "Right ⌥",
  LeftAlt: "Left ⌥",
  RightCtrl: "Right ⌃",
  RightCmd: "Right ⌘",
  ScrollLock: "ScrLk",
  F8: "F8",
  F9: "F9",
}

const HOTKEY_OPTION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  Fn: "Apple default. Doesn't collide with app shortcuts.",
  LeftCtrl: "Left of the keyboard. Rarely held while typing.",
  RightAlt: "Right of the space bar, easy to hold.",
  LeftAlt: "Single key, common in Win/Linux apps.",
  RightCtrl: "Less commonly bound — usually safe.",
  RightCmd: "Right of the space bar. Alone it triggers nothing.",
  ScrollLock: "Almost never used by other apps.",
  F8: "Function-row key.",
  F9: "Function-row key.",
}

/**
 * Two keys on each half of the keyboard, none of them held during normal
 * typing. On macOS all four go through the signed Swift helper; F8/F9 are
 * media keys on Apple keyboards and Right Control is absent on laptops, so
 * they are not offered there. Windows/Linux keep the plain-key set handled by
 * node-global-key-listener.
 */
function platformHotkeyChoices(): readonly string[] {
  const isMac = navigator.platform.toLowerCase().includes("mac")
  if (isMac) {
    return ["Fn", "LeftCtrl", "RightAlt", "RightCmd"]
  }
  return ["RightAlt", "LeftAlt", "RightCtrl", "ScrollLock", "F8", "F9"]
}

function renderHotkey(combo: string): void {
  if (hotkeyDisplay === null) return
  hotkeyDisplay.textContent = HOTKEY_LABELS[combo] ?? `Hold ${combo}`
}

// Map DOM `KeyboardEvent.code` values to our supported combo strings. Anything
// not in this table is rejected with a friendly message in the modal.
const KEY_CODE_TO_COMBO: Readonly<Record<string, string>> = {
  ControlLeft: "LeftCtrl",
  MetaRight: "RightCmd",
  AltRight: "RightAlt",
  AltLeft: "LeftAlt",
  ControlRight: "RightCtrl",
  ScrollLock: "ScrollLock",
  F8: "F8",
  F9: "F9",
}

// Pending selection inside the modal. Confirmed on Save; reset on Cancel.
let pendingCombo: string | null = null

function renderHotkeyModal(currentCombo: string): void {
  pendingCombo = null
  // Capture region: reset to listening state.
  if (hotkeyCapture !== null) hotkeyCapture.classList.remove("is-listening")
  if (hotkeyCaptureState !== null) hotkeyCaptureState.textContent = "Press a key…"
  if (hotkeyCaptureKey !== null) {
    hotkeyCaptureKey.hidden = true
    hotkeyCaptureKey.textContent = ""
  }
  if (hotkeyCaptureHint !== null) {
    hotkeyCaptureHint.classList.remove("is-error")
    hotkeyCaptureHint.innerHTML = `
      Allowed: <span class="mono">F8</span>, <span class="mono">F9</span>,
      <span class="mono">Right Alt</span>, <span class="mono">Right Ctrl</span>,
      <span class="mono">Scroll Lock</span>
    `
  }
  if (hotkeyModalSaveBtn !== null) hotkeyModalSaveBtn.disabled = true

  // Preset list (Fn for Mac, plus any non-capture-friendly combos).
  if (hotkeyModalOptions !== null) {
    hotkeyModalOptions.innerHTML = ""
    for (const combo of platformHotkeyChoices()) {
      const selected = combo === currentCombo
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = `hotkey-option${selected ? " is-selected" : ""}`
      btn.dataset["combo"] = combo
      btn.innerHTML = `
        <span class="hotkey-option-key mono">${HOTKEY_KEY_LABELS[combo] ?? combo}</span>
        <span class="hotkey-option-label">${HOTKEY_OPTION_DESCRIPTIONS[combo] ?? ""}</span>
      `
      btn.addEventListener("click", () => {
        setPendingCombo(combo, /* fromPress */ false)
      })
      hotkeyModalOptions.appendChild(btn)
    }
  }
}

function setPendingCombo(combo: string, fromPress: boolean): void {
  pendingCombo = combo
  if (hotkeyCaptureState !== null) {
    hotkeyCaptureState.textContent = fromPress ? "Got it." : "Selected."
  }
  if (hotkeyCaptureKey !== null) {
    hotkeyCaptureKey.hidden = false
    hotkeyCaptureKey.textContent = HOTKEY_KEY_LABELS[combo] ?? combo
  }
  if (hotkeyCaptureHint !== null) {
    hotkeyCaptureHint.classList.remove("is-error")
    hotkeyCaptureHint.innerHTML = `Press Save to use <span class="mono">${HOTKEY_KEY_LABELS[combo] ?? combo}</span> as your push-to-talk key.`
  }
  // Highlight matching preset row.
  if (hotkeyModalOptions !== null) {
    for (const el of hotkeyModalOptions.querySelectorAll<HTMLElement>(".hotkey-option")) {
      el.classList.toggle("is-selected", el.dataset["combo"] === combo)
    }
  }
  if (hotkeyModalSaveBtn !== null) hotkeyModalSaveBtn.disabled = false
  if (hotkeyCapture !== null) hotkeyCapture.classList.remove("is-listening")
}

function rejectCapturedKey(rawKey: string): void {
  if (hotkeyCaptureHint !== null) {
    hotkeyCaptureHint.classList.add("is-error")
    hotkeyCaptureHint.innerHTML = `<span class="mono">${rawKey}</span> isn't supported. Pick one of the presets below, or press one of those keys.`
  }
}

function openHotkeyModal(): void {
  if (hotkeyModal === null || currentSnapshot === null) return
  renderHotkeyModal(currentSnapshot.hotkey)
  hotkeyModal.hidden = false
  // Focus the capture region so keydowns are heard. macOS Fn key never fires
  // keydown via the DOM (the Swift helper is the only path), so users on Mac
  // must use the Fn preset row for that specific combo.
  hotkeyCapture?.focus()
  hotkeyCapture?.classList.add("is-listening")
}

function closeHotkeyModal(): void {
  if (hotkeyModal === null) return
  hotkeyModal.hidden = true
  pendingCombo = null
}

function commitPendingHotkey(): void {
  if (pendingCombo === null) return
  const combo = pendingCombo
  void window.opennib.settings
    .setHotkey(combo)
    .then(() => {
      closeHotkeyModal()
    })
    .catch((err) => {
      console.error("setHotkey failed", err)
    })
}

// Keydown listener while the modal is open: capture supported keys, reject
// unsupported ones with a hint. Bubbles globally because the capture div may
// not always own focus inside the modal (e.g. user tabs to a preset).
function onModalKeydown(e: KeyboardEvent): void {
  if (hotkeyModal === null || hotkeyModal.hidden) return
  // Ignore modifier-only synthetic events and key combinations.
  if (e.key === "Escape" || e.key === "Enter" || e.key === "Tab") return
  if (e.altKey && e.metaKey) return
  const combo = KEY_CODE_TO_COMBO[e.code]
  if (combo === undefined) {
    e.preventDefault()
    rejectCapturedKey(e.key.length === 1 ? e.key.toUpperCase() : e.key)
    return
  }
  e.preventDefault()
  setPendingCombo(combo, true)
}

if (hotkeyChangeBtn !== null) {
  hotkeyChangeBtn.addEventListener("click", openHotkeyModal)
}
if (hotkeyModalCancelBtn !== null) {
  hotkeyModalCancelBtn.addEventListener("click", closeHotkeyModal)
}
if (hotkeyModalSaveBtn !== null) {
  hotkeyModalSaveBtn.addEventListener("click", commitPendingHotkey)
}
if (hotkeyModal !== null) {
  // Click backdrop (the modal element itself, not the card inside) closes.
  hotkeyModal.addEventListener("click", (e) => {
    if (e.target === hotkeyModal) closeHotkeyModal()
  })
}
// Keydown listener: ESC closes; any other key while the modal is open is
// fed to the hotkey capture logic.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && hotkeyModal !== null && !hotkeyModal.hidden) {
    closeHotkeyModal()
    return
  }
  onModalKeydown(e)
})

// ─── Permissions list (General panel) ────────────────────────────────

const MIC_ICON_SVG = `<svg viewBox="0 0 18 18" width="17" height="17" fill="none" aria-hidden="true">
  <rect x="6.5" y="2" width="5" height="9" rx="2.5" stroke="currentColor" stroke-width="1.4"/>
  <path d="M4 9a5 5 0 0 0 10 0M9 14v2.5M6 16.5h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>`

const ACC_ICON_SVG = `<svg viewBox="0 0 18 18" width="17" height="17" fill="none" aria-hidden="true">
  <circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.4"/>
  <path d="M9 5.5v.01M9 8.5v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`

const CHECK_SVG = `<svg viewBox="0 0 14 14" width="13" height="13" fill="none">
  <path d="M2.5 7.5l3 3 6-7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

const X_SVG = `<svg viewBox="0 0 14 14" width="13" height="13" fill="none">
  <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
</svg>`

function renderPermissions(snap: SystemStatusSnapshot): void {
  if (permissionsList === null) return
  const rows: {
    key: "microphone" | "accessibility" | "input-monitoring"
    icon: string
    label: string
    hint: string
    state: "granted" | "denied" | "undetermined"
    cta: "request" | "open" | "none"
  }[] = []

  rows.push({
    key: "microphone",
    icon: MIC_ICON_SVG,
    label: "Microphone",
    hint: "Required to hear your voice while you dictate.",
    state: snap.microphone,
    cta: snap.microphone === "granted" ? "none" : snap.microphone === "denied" ? "open" : "request",
  })

  // Accessibility is a Mac-only concept; on Win/Linux it returns null. Skip
  // the row entirely there — the design's three-row list is mac-specific.
  if (snap.accessibility !== null) {
    rows.push({
      key: "accessibility",
      icon: ACC_ICON_SVG,
      label: "Accessibility",
      hint: "Lets opennib insert transcribed text into the app you're typing in.",
      state: snap.accessibility,
      cta: snap.accessibility === "granted" ? "none" : "open",
    })
  }

  // The hotkey helper is its own client to macOS until the app is signed;
  // "unknown" means the active adapter can't report, so no row.
  if (snap.keyboardAccess !== "unknown") {
    rows.push({
      key: "input-monitoring",
      icon: ACC_ICON_SVG,
      label: "Keyboard access",
      hint: "Lets opennib notice when you hold the dictation key. Allow it under Input Monitoring.",
      state: snap.keyboardAccess === "granted" ? "granted" : "undetermined",
      cta: snap.keyboardAccess === "granted" ? "none" : "open",
    })
  }

  permissionsList.innerHTML = ""
  for (const row of rows) {
    const el = document.createElement("div")
    el.className = "perm-row"
    el.innerHTML = `
      <div class="perm-icon">${row.icon}</div>
      <div class="perm-text">
        <div class="perm-label">${row.label}</div>
        <div class="perm-hint">${row.hint}</div>
      </div>
    `
    const right = document.createElement("div")
    right.className = "perm-row-required"
    if (row.state === "granted") {
      right.innerHTML = `<span class="perm-status" data-state="granted">${CHECK_SVG} Allowed</span>`
    } else {
      const statusLabel = row.state === "denied" ? "Required" : "Required"
      right.innerHTML = `<span class="perm-status" data-state="required">${X_SVG} ${statusLabel}</span>`
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = "btn btn-sm"
      btn.textContent = row.cta === "request" ? "Grant" : "Open Settings"
      btn.addEventListener("click", () => {
        if (row.cta === "request") {
          void window.opennib.system.requestMicrophone().then(renderPermissions)
        } else {
          void window.opennib.system.openSettings(row.key)
        }
      })
      right.appendChild(btn)
    }
    el.appendChild(right)
    permissionsList.appendChild(el)
  }
}

// ─── Readiness banner (still rendered for blocking issues) ───────────

function renderReadiness(snapshot: SystemStatusSnapshot): void {
  if (readinessBanner === null) return
  const issues: { key: string; message: string; cta?: { label: string; action: () => void } }[] = []

  if (snapshot.loadError !== null) {
    const { modelId: id, message, kind } = snapshot.loadError
    const headline = `The active model (${id}) failed to load.`
    const issue: { key: string; message: string; cta?: { label: string; action: () => void } } = {
      key: "load-error",
      message:
        kind === "file"
          ? `${headline} The file may be corrupt — re-download to fix.`
          : `${headline} ${message}`,
    }
    if (kind === "file") {
      issue.cta = {
        label: "Re-download",
        action: () => {
          void window.opennib.models
            .remove(id)
            .then(() => window.opennib.models.download(id))
            .then(() => refreshReadiness())
            .catch((err) => {
              console.error("re-download failed", err)
            })
        },
      }
    }
    issues.push(issue)
  } else if (!snapshot.activeModelInstalled) {
    issues.push({
      key: "model",
      message: `The active model (${snapshot.activeModelId}) isn't downloaded yet.`,
      cta: {
        label: "Download",
        action: () => {
          void window.opennib.models.download(snapshot.activeModelId).catch((err) => {
            console.error("download failed", err)
          })
        },
      },
    })
  }

  // Mic + Accessibility are also surfaced in the General → Permissions panel,
  // but we keep them in this top-of-window banner so a denied state is loud no
  // matter which page the user is on.
  if (snapshot.microphone !== "granted") {
    issues.push({
      key: "mic",
      message:
        snapshot.microphone === "denied"
          ? "Microphone access was denied. Enable it in System Settings → Privacy & Security → Microphone."
          : "Microphone access is required to record dictation.",
      ...(snapshot.microphone === "undetermined"
        ? {
            cta: {
              label: "Grant access",
              action: () => {
                void window.opennib.system.requestMicrophone().then(renderReadiness)
              },
            },
          }
        : {
            cta: {
              label: "Open Settings",
              action: () => {
                void window.opennib.system.openSettings("microphone")
              },
            },
          }),
    })
  }
  if (snapshot.accessibility !== null && snapshot.accessibility !== "granted") {
    issues.push({
      key: "acc",
      message:
        "Accessibility access is required to paste text into the focused app. Enable it in System Settings → Privacy & Security → Accessibility.",
      cta: {
        label: "Open Settings",
        action: () => {
          void window.opennib.system.openSettings("accessibility")
        },
      },
    })
  }

  readinessBanner.innerHTML = ""
  if (issues.length === 0) {
    readinessBanner.hidden = true
    return
  }
  readinessBanner.hidden = false
  for (const issue of issues) {
    const row = document.createElement("div")
    row.className = "readiness-row"
    row.dataset["issue"] = issue.key
    const text = document.createElement("span")
    text.textContent = issue.message
    row.append(text)
    if (issue.cta !== undefined) {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.textContent = issue.cta.label
      btn.addEventListener("click", issue.cta.action)
      row.append(btn)
    }
    readinessBanner.append(row)
  }
}

async function refreshReadiness(): Promise<void> {
  try {
    const snapshot = await window.opennib.system.status()
    renderReadiness(snapshot)
    renderPermissions(snapshot)
  } catch (err) {
    console.error("system.status failed", err)
  }
}

window.addEventListener("focus", () => {
  void refreshReadiness()
})

// ─── Models (Transcription only — LLM cleanup hidden per v0.8 design) ─

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`
  return `${bytes} B`
}

const MODEL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  tiny: "Fastest. Good for quick notes.",
  "tiny.en": "Fastest. English only.",
  base: "Quick and decent.",
  "base.en": "Quick. English only.",
  small: "Recommended. Balanced speed + quality.",
  "small.en": "Balanced. English only.",
  medium: "Slower, much better at names.",
  "medium.en": "Slower. English only.",
  "large-v3": "Best quality. Slowest.",
  "large-v3-turbo": "Medium quality at Small speed.",
}

function describeModelStatus(entry: ModelEntry): string {
  const live = modelProgress.get(entry.id)
  if (live?.state === "downloading") return `Downloading… ${live.percent}%`
  if (live?.state === "failed") return `Failed: ${live.error ?? "unknown error"}`
  if (entry.downloading) return "Downloading…"
  if (entry.installed) return entry.active ? "Active" : "Installed"
  return "Not downloaded"
}

function renderModelRow(entry: ModelEntry): HTMLLIElement {
  const li = document.createElement("li")
  li.className = "model-row"
  li.dataset["active"] = entry.active ? "true" : "false"
  li.dataset["installed"] = entry.installed ? "true" : "false"

  const radio = document.createElement("span")
  radio.className = "model-radio"
  radio.innerHTML = `<span class="model-radio-dot"></span>`

  const meta = document.createElement("div")
  meta.className = "model-meta"
  const line = document.createElement("div")
  line.className = "model-meta-line"
  const name = document.createElement("span")
  name.className = "model-name"
  name.textContent = entry.displayName
  const size = document.createElement("span")
  size.className = "model-size"
  size.textContent = formatBytes(entry.approxSizeBytes)
  line.append(name, size)
  meta.append(line)
  const desc = document.createElement("div")
  desc.className = "model-desc"
  desc.textContent = MODEL_DESCRIPTIONS[entry.id] ?? ""
  meta.append(desc)
  const stateLabel = document.createElement("div")
  stateLabel.className = "model-state"
  stateLabel.dataset["modelState"] = entry.id
  const live = modelProgress.get(entry.id)
  stateLabel.textContent = describeModelStatus(entry)
  if (live?.state === "downloading") stateLabel.dataset["state"] = "downloading"
  else if (live?.state === "failed") stateLabel.dataset["state"] = "failed"
  meta.append(stateLabel)

  const actions = document.createElement("div")
  actions.className = "model-actions"
  const isDownloading = entry.downloading || live?.state === "downloading"

  if (entry.active) {
    const chip = document.createElement("span")
    chip.className = "chip chip-rec"
    chip.textContent = "Active"
    actions.appendChild(chip)
    const removeBtn = document.createElement("button")
    removeBtn.type = "button"
    removeBtn.className = "btn btn-sm"
    removeBtn.textContent = "Remove"
    removeBtn.disabled = true // can't remove the currently-active model
    actions.appendChild(removeBtn)
  } else if (entry.installed) {
    const useBtn = document.createElement("button")
    useBtn.type = "button"
    useBtn.className = "btn btn-primary btn-sm"
    useBtn.textContent = "Use"
    useBtn.addEventListener("click", () => {
      void window.opennib.settings.setModel(entry.id).catch((err) => {
        console.error("setModel failed", err)
      })
    })
    actions.appendChild(useBtn)
    const removeBtn = document.createElement("button")
    removeBtn.type = "button"
    removeBtn.className = "btn btn-sm btn-danger"
    removeBtn.textContent = "Remove"
    removeBtn.addEventListener("click", () => {
      void window.opennib.models
        .remove(entry.id)
        .then(() => refreshModels())
        .catch((err) => {
          console.error("remove failed", err)
        })
    })
    actions.appendChild(removeBtn)
  } else if (!isDownloading) {
    const dlBtn = document.createElement("button")
    dlBtn.type = "button"
    dlBtn.className = "btn btn-sm"
    dlBtn.innerHTML = `
      <svg viewBox="0 0 10 10" width="10" height="10" fill="none" aria-hidden="true">
        <path d="M5 1v6m0 0L2 4m3 3l3-3M2 9h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Download
    `
    dlBtn.addEventListener("click", () => {
      modelProgress.set(entry.id, { percent: 0, state: "downloading" })
      stateLabel.textContent = describeModelStatus(entry)
      stateLabel.dataset["state"] = "downloading"
      void window.opennib.models.download(entry.id).catch((err) => {
        console.error("download failed", err)
      })
    })
    actions.appendChild(dlBtn)
  }

  li.append(radio, meta, actions)
  return li
}

async function refreshModels(): Promise<void> {
  if (whisperModelList === null) return
  let entries: readonly ModelEntry[]
  try {
    entries = await window.opennib.models.list()
  } catch (err) {
    console.error("models.list failed", err)
    return
  }
  lastModelEntries = entries

  whisperModelList.innerHTML = ""
  for (const entry of entries) {
    if (entry.kind !== "whisper") continue
    whisperModelList.appendChild(renderModelRow(entry))
  }
}

window.opennib.models.onProgress((event) => {
  modelProgress.set(event.modelId, {
    percent: event.percent,
    state: event.state,
    error: event.error,
  })
  const label = document.querySelector<HTMLSpanElement>(`[data-model-state="${event.modelId}"]`)
  if (label !== null) {
    label.textContent =
      event.state === "downloading"
        ? `Downloading… ${event.percent}%`
        : event.state === "failed"
          ? `Failed: ${event.error ?? "unknown error"}`
          : "Installed"
    label.dataset["state"] =
      event.state === "downloading"
        ? "downloading"
        : event.state === "failed"
          ? "failed"
          : "installed"
  }
  if (event.state === "completed" || event.state === "failed") {
    modelProgress.delete(event.modelId)
    void refreshModels()
    void refreshReadiness()
  }
})

// ─── History ─────────────────────────────────────────────────────────

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { hour: "numeric", minute: "2-digit" })
}

function formatDuration(durationMs: number): string {
  const total = Math.round(durationMs / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function dayGroup(entryMs: number, nowMs: number): string {
  const entryDay = startOfDay(entryMs)
  const today = startOfDay(nowMs)
  const dayMs = 86_400_000
  if (entryDay === today) return "Today"
  if (entryDay === today - dayMs) return "Yesterday"
  if (entryDay > today - dayMs * 7) return "This week"
  // Older entries land in a single bucket labeled "Earlier" — keeps the
  // section list short rather than fragmenting into per-day headers.
  return "Earlier"
}

const COPY_ICON_SVG = `<svg viewBox="0 0 14 14" width="14" height="14" fill="none">
  <rect x="4" y="2" width="7" height="9" rx="1" stroke="currentColor" stroke-width="1.3"/>
  <path d="M3 4.5v7c0 .6.5 1 1 1h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/>
</svg>`

const NIB_SMALL_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
  <path d="M 5 6 Q 5 3, 8 3 L 16 3 Q 19 3, 19 6 L 19 12 L 12 21.5 L 5 12 Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="12" cy="7.5" r="1.6" fill="currentColor"/>
  <line x1="12" y1="9.7" x2="12" y2="17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`

function highlightMatch(text: string, query: string): string {
  if (query === "") return escapeHtml(text)
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let out = ""
  let i = 0
  while (i < text.length) {
    const idx = lower.indexOf(q, i)
    if (idx === -1) {
      out += escapeHtml(text.slice(i))
      break
    }
    out += escapeHtml(text.slice(i, idx))
    out += `<mark>${escapeHtml(text.slice(idx, idx + q.length))}</mark>`
    i = idx + q.length
  }
  return out
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  )
}

function renderHistory(): void {
  if (historyGroups === null) return

  const filtered =
    historyQuery === ""
      ? historyEntries
      : historyEntries.filter((e) => e.text.toLowerCase().includes(historyQuery.toLowerCase()))

  if (filtered.length === 0) {
    historyGroups.innerHTML = ""
    if (historyEmpty !== null) {
      historyEmpty.hidden = false
      historyEmpty.textContent =
        historyQuery === "" ? "No transcripts yet." : `No transcripts match "${historyQuery}".`
    }
    if (historyClearBtn !== null) historyClearBtn.disabled = historyEntries.length === 0
    return
  }
  if (historyEmpty !== null) historyEmpty.hidden = true
  if (historyClearBtn !== null) historyClearBtn.disabled = false

  const now = Date.now()
  const groupOrder = ["Today", "Yesterday", "This week", "Earlier"] as const
  const groups = new Map<string, TranscriptEntry[]>()
  for (const entry of filtered) {
    const key = dayGroup(entry.createdAt, now)
    const arr = groups.get(key)
    if (arr === undefined) groups.set(key, [entry])
    else arr.push(entry)
  }

  historyGroups.innerHTML = ""
  let firstRowRendered = false
  for (const key of groupOrder) {
    const list = groups.get(key)
    if (list === undefined) continue
    const label = document.createElement("div")
    label.className = "history-section-label"
    label.textContent = key
    historyGroups.appendChild(label)
    for (const entry of list) {
      const row = document.createElement("div")
      row.className = "history-row"
      if (!firstRowRendered) {
        row.classList.add("is-selected")
        firstRowRendered = true
      }
      const tile = document.createElement("div")
      tile.className = "history-row-tile"
      tile.innerHTML = NIB_SMALL_SVG
      const main = document.createElement("div")
      main.className = "history-row-main"
      const meta = document.createElement("div")
      meta.className = "history-row-meta"
      const lang = entry.language === "auto" ? "auto" : entry.language.toUpperCase()
      meta.textContent = `${formatTime(entry.createdAt)} · ${formatDuration(entry.durationMs)} · ${lang}`
      const text = document.createElement("div")
      text.className = "history-row-text"
      text.innerHTML = highlightMatch(entry.text, historyQuery)
      main.append(meta, text)
      const actions = document.createElement("div")
      actions.className = "history-row-actions"
      const copyBtn = document.createElement("button")
      copyBtn.type = "button"
      copyBtn.className = "history-row-action"
      copyBtn.title = "Copy transcript"
      copyBtn.innerHTML = COPY_ICON_SVG
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(entry.text).catch((err) => {
          console.error("clipboard write failed", err)
        })
      })
      actions.appendChild(copyBtn)
      row.append(tile, main, actions)
      historyGroups.appendChild(row)
    }
  }
}

async function refreshHistory(): Promise<void> {
  try {
    historyEntries = await window.opennib.history.list({ limit: HISTORY_LIMIT })
  } catch (err) {
    console.error("history.list failed", err)
    return
  }
  if (navHistoryCount !== null) {
    navHistoryCount.textContent = historyEntries.length === 0 ? "" : String(historyEntries.length)
  }
  renderHistory()
}

if (historyClearBtn !== null) {
  historyClearBtn.addEventListener("click", () => {
    if (!confirm("Clear all transcript history?")) return
    void window.opennib.history
      .clear()
      .then(() => refreshHistory())
      .catch((err) => {
        console.error("history.clear failed", err)
      })
  })
}

if (historySearchInput !== null) {
  historySearchInput.addEventListener("input", () => {
    historyQuery = historySearchInput.value.trim()
    renderHistory()
  })
}

// ─── Dictionary ──────────────────────────────────────────────────────

const ARROW_SVG = `<svg viewBox="0 0 14 10" width="14" height="10" fill="none" aria-hidden="true">
  <path d="M1 5h11M9 1l3 4-3 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

const DELETE_X_SVG = `<svg viewBox="0 0 14 14" width="12" height="12" fill="none" aria-hidden="true">
  <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>`

function renderDictionary(): void {
  if (dictionaryList === null) return

  const filtered =
    dictionaryQuery === ""
      ? dictionaryEntries
      : dictionaryEntries.filter(
          (e) =>
            e.term.toLowerCase().includes(dictionaryQuery.toLowerCase()) ||
            (e.replacement !== undefined &&
              e.replacement.toLowerCase().includes(dictionaryQuery.toLowerCase())),
        )

  const formIsHidden = dictionaryForm?.hidden ?? true

  dictionaryList.innerHTML = ""
  if (filtered.length === 0) {
    if (dictionaryEmpty !== null) {
      dictionaryEmpty.hidden = !formIsHidden
      dictionaryEmpty.textContent =
        dictionaryQuery === ""
          ? "No corrections yet."
          : `No corrections match "${dictionaryQuery}".`
    }
    if (navDictionaryCount !== null) {
      navDictionaryCount.textContent =
        dictionaryEntries.length === 0 ? "" : String(dictionaryEntries.length)
    }
    return
  }
  if (dictionaryEmpty !== null) dictionaryEmpty.hidden = true

  const sorted = [...filtered].sort((a, b) => a.term.localeCompare(b.term))
  for (const entry of sorted) {
    const li = document.createElement("li")
    li.className = "dict-row"

    // Reading order is spoken → enforced ("WHEN YOU SAY → INSERT"). Core's
    // `replacement` is the spoken form and `term` the enforced spelling, so
    // the left cell renders `replacement` and the right cell `term`.
    const term = document.createElement("span")
    term.className = "dict-row-term"
    const arrow = document.createElement("span")
    arrow.className = "dict-arrow"
    arrow.innerHTML = ARROW_SVG
    const repl = document.createElement("span")
    repl.className = "dict-row-replacement"
    repl.textContent = entry.term
    if (entry.replacement !== undefined && entry.replacement.length > 0) {
      term.textContent = entry.replacement
    } else {
      term.textContent = "(proper noun)"
      term.classList.add("is-empty")
    }
    const del = document.createElement("span")
    del.className = "dict-row-delete"
    const delBtn = document.createElement("button")
    delBtn.type = "button"
    delBtn.title = "Remove correction"
    delBtn.innerHTML = DELETE_X_SVG
    delBtn.addEventListener("click", () => {
      void window.opennib.dictionary
        .remove(entry.id)
        .then(() => refreshDictionary())
        .catch((err) => {
          console.error("dictionary.remove failed", err)
        })
    })
    del.appendChild(delBtn)

    li.append(term, arrow, repl, del)
    dictionaryList.appendChild(li)
  }

  if (navDictionaryCount !== null) {
    navDictionaryCount.textContent =
      dictionaryEntries.length === 0 ? "" : String(dictionaryEntries.length)
  }
}

async function refreshDictionary(): Promise<void> {
  try {
    dictionaryEntries = await window.opennib.dictionary.list()
  } catch (err) {
    console.error("dictionary.list failed", err)
    return
  }
  renderDictionary()
}

function setDictAddRowOpen(open: boolean): void {
  if (dictionaryForm === null) return
  dictionaryForm.hidden = !open
  if (open) {
    dictionaryTermInput?.focus()
  } else {
    if (dictionaryTermInput !== null) dictionaryTermInput.value = ""
    if (dictionaryReplacementInput !== null) dictionaryReplacementInput.value = ""
  }
  renderDictionary()
}

if (dictionaryAddBtn !== null) {
  dictionaryAddBtn.addEventListener("click", () => {
    setDictAddRowOpen(dictionaryForm?.hidden !== false)
  })
}

if (dictionaryCancelBtn !== null) {
  dictionaryCancelBtn.addEventListener("click", () => {
    setDictAddRowOpen(false)
  })
}

if (dictionarySearchInput !== null) {
  dictionarySearchInput.addEventListener("input", () => {
    dictionaryQuery = dictionarySearchInput.value.trim()
    renderDictionary()
  })
}

if (dictionaryForm !== null) {
  dictionaryForm.addEventListener("submit", (event) => {
    event.preventDefault()
    if (dictionaryTermInput === null) return
    // Core semantics: `term` = enforced spelling (the INSERT column), while
    // `replacement` = spoken phrase (the WHEN YOU SAY column / first input).
    const spoken = dictionaryTermInput.value.trim()
    const insert = dictionaryReplacementInput?.value.trim() ?? ""
    if (insert.length === 0) return
    const entry: DictionaryEntry =
      spoken.length > 0
        ? {
            id: crypto.randomUUID(),
            term: insert,
            replacement: spoken,
            createdAt: Date.now(),
          }
        : { id: crypto.randomUUID(), term: insert, createdAt: Date.now() }
    void window.opennib.dictionary
      .add(entry)
      .then(() => {
        setDictAddRowOpen(false)
        return refreshDictionary()
      })
      .catch((err) => {
        console.error("dictionary.add failed", err)
      })
  })
}

// ─── Mode picker (Dictation panel) ──────────────────────────────────

function renderModePicker(mode: "hold" | "tap" | "tap-twice"): void {
  if (modePicker === null) return
  for (const btn of modePicker.querySelectorAll<HTMLButtonElement>(".seg-btn")) {
    const active = btn.dataset["mode"] === mode
    btn.classList.toggle("is-active", active)
    btn.setAttribute("aria-checked", active ? "true" : "false")
  }
}

if (modePicker !== null) {
  modePicker.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(".seg-btn")
    if (target === null || target === undefined) return
    const mode = target.dataset["mode"]
    if (mode !== "hold" && mode !== "tap" && mode !== "tap-twice") return
    void window.opennib.settings.setHotkeyMode(mode).catch((err) => {
      console.error("setHotkeyMode failed", err)
    })
  })
}

// ─── Sounds (Dictation panel) ────────────────────────────────────────

// Lazy AudioContext for tick sounds — created on first play to avoid an
// autoplay warning when the renderer boots without user interaction.
let audioCtx: AudioContext | null = null

function getAudioCtx(): AudioContext | null {
  if (audioCtx !== null) return audioCtx
  try {
    audioCtx = new AudioContext()
    return audioCtx
  } catch {
    return null
  }
}

function playTick(frequencyHz: number): void {
  const ctx = getAudioCtx()
  if (ctx === null) return
  // Short attack/release envelope to avoid clicks.
  const now = ctx.currentTime
  const osc = ctx.createOscillator()
  osc.type = "sine"
  osc.frequency.value = frequencyHz
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.05, now + 0.005)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08)
  osc.connect(gain).connect(ctx.destination)
  osc.start(now)
  osc.stop(now + 0.1)
}

function renderSoundToggles(snap: SettingsSnapshot): void {
  if (dictationSoundsToggle !== null) {
    dictationSoundsToggle.setAttribute("aria-checked", snap.dictationSounds ? "true" : "false")
  }
  if (notificationSoundsToggle !== null) {
    notificationSoundsToggle.setAttribute(
      "aria-checked",
      snap.notificationSounds ? "true" : "false",
    )
  }
}

if (dictationSoundsToggle !== null) {
  dictationSoundsToggle.addEventListener("click", () => {
    if (currentSnapshot === null) return
    void window.opennib.settings
      .setDictationSounds(!currentSnapshot.dictationSounds)
      .catch((err) => {
        console.error("setDictationSounds failed", err)
      })
  })
}

if (notificationSoundsToggle !== null) {
  notificationSoundsToggle.addEventListener("click", () => {
    if (currentSnapshot === null) return
    void window.opennib.settings
      .setNotificationSounds(!currentSnapshot.notificationSounds)
      .catch((err) => {
        console.error("setNotificationSounds failed", err)
      })
  })
}

// ─── First-run shortcut hint (D-S-1) ─────────────────────────────────

function maybeShowFirstRunHint(snap: SettingsSnapshot): void {
  if (firstRunHint === null) return
  // Show once, after onboarding has been completed at least once and the user
  // hasn't already dismissed the hint. The "Got it" handler persists the flag.
  if (!snap.onboardingCompleted) return
  if (snap.firstRunHintShown) return
  if (firstRunKeyLabel !== null) {
    firstRunKeyLabel.textContent = HOTKEY_KEY_LABELS[snap.hotkey] ?? snap.hotkey
  }
  firstRunHint.hidden = false
}

if (firstRunDismissBtn !== null) {
  firstRunDismissBtn.addEventListener("click", () => {
    if (firstRunHint !== null) firstRunHint.hidden = true
    void window.opennib.settings.setFirstRunHintShown(true).catch((err) => {
      console.error("setFirstRunHintShown failed", err)
    })
  })
}

if (firstRunChangeBtn !== null) {
  firstRunChangeBtn.addEventListener("click", () => {
    if (firstRunHint !== null) firstRunHint.hidden = true
    void window.opennib.settings.setFirstRunHintShown(true).catch(() => undefined)
    // Open the Dictation tab so the hotkey picker is visible, then surface
    // the modal so the user can pick a different key right away.
    selectTab("dictation")
    openHotkeyModal()
  })
}

// ─── Startup toggles (General) ───────────────────────────────────────

function renderStartupToggles(snap: SettingsSnapshot): void {
  if (launchAtLoginToggle !== null) {
    launchAtLoginToggle.setAttribute("aria-checked", snap.launchAtLogin ? "true" : "false")
  }
  if (showInDockToggle !== null) {
    showInDockToggle.setAttribute("aria-checked", snap.showInDock ? "true" : "false")
  }
  // "Show in dock" is mac-only — app.dock is undefined on Windows/Linux, and
  // we don't render a taskbar entry there. Hide the row so the design doesn't
  // promise behavior we can't deliver.
  if (rowShowInDock !== null) {
    const isMac = navigator.platform.toLowerCase().includes("mac")
    rowShowInDock.hidden = !isMac
  }
}

if (launchAtLoginToggle !== null) {
  launchAtLoginToggle.addEventListener("click", () => {
    if (currentSnapshot === null) return
    const next = !currentSnapshot.launchAtLogin
    void window.opennib.settings.setLaunchAtLogin(next).catch((err) => {
      console.error("setLaunchAtLogin failed", err)
    })
  })
}

if (showInDockToggle !== null) {
  showInDockToggle.addEventListener("click", () => {
    if (currentSnapshot === null) return
    const next = !currentSnapshot.showInDock
    void window.opennib.settings.setShowInDock(next).catch((err) => {
      console.error("setShowInDock failed", err)
    })
  })
}

// ─── Reset onboarding (General) ──────────────────────────────────────

if (resetOnboardingBtn !== null) {
  resetOnboardingBtn.addEventListener("click", () => {
    void window.opennib.onboarding.reset().catch((err) => {
      console.error("onboarding.reset failed", err)
    })
  })
}

// ─── Top-level wiring ────────────────────────────────────────────────

renderState("idle")

window.opennib.state.onChange((state) => {
  renderState(state)
  // After a successful dictation cycle the new transcript is appended to
  // history; refresh once we're back to idle to surface it.
  if (lastPipelineState === "processing" && state === "idle") {
    void refreshHistory()
  }
  // Dictation tick: brighter "start" pitch on idle→recording, softer "end"
  // pitch on recording→processing. Silent during processing→idle (the user
  // gets visual confirmation when the transcript pastes anyway).
  if (currentSnapshot?.dictationSounds === true) {
    if (lastPipelineState === "idle" && state === "recording") playTick(880)
    else if (lastPipelineState === "recording" && state === "processing") playTick(587)
  }
  lastPipelineState = state
})

window.opennib.settings.onChange((snapshot) => {
  currentSnapshot = snapshot
  if (languageSelect !== null && languageSelect.value !== snapshot.language) {
    languageSelect.value = snapshot.language
  }
  if (micSelect !== null && micSelect.value !== (snapshot.selectedMicId ?? "")) {
    micSelect.value = snapshot.selectedMicId ?? ""
  }
  renderHotkey(snapshot.hotkey)
  renderStartupToggles(snapshot)
  renderModePicker(snapshot.hotkeyMode)
  renderSoundToggles(snapshot)
  maybeShowFirstRunHint(snapshot)
  void refreshModels()
  void refreshReadiness()
})

async function init(): Promise<void> {
  // Settings + mic enumeration race: we need both before the mic picker can
  // render with the user's selection preserved. Fetch in parallel.
  const [snapshot] = await Promise.all([window.opennib.settings.get(), loadMicDevices()])
  currentSnapshot = snapshot
  renderLanguagePicker(snapshot.language)
  renderMicPicker(snapshot.selectedMicId)
  renderHotkey(snapshot.hotkey)
  renderStartupToggles(snapshot)
  renderModePicker(snapshot.hotkeyMode)
  renderSoundToggles(snapshot)
  maybeShowFirstRunHint(snapshot)

  await Promise.all([refreshHistory(), refreshDictionary(), refreshModels(), refreshReadiness()])
}

void init()

installRecorder()

// Suppress unused-warning for the model-entries snapshot we keep around for
// future cross-panel features (settings → quick model switch). Reading from
// settings is cheap; this just avoids a stale reference if something fails.
void lastModelEntries

export {}
