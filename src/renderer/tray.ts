// Tray popover renderer. Lives in a frameless transparent BrowserWindow
// shown when the user clicks the menu-bar icon. Pulls state via the shared
// preload bridge; sends user intents back through `window.opennib.tray.*`
// and `window.opennib.settings.*`.

import { SUPPORTED_LANGUAGES } from "@opennib/core"

import type { OpennibPreloadApi, PipelineState, SettingsSnapshot } from "../shared/preload-api"

declare global {
  interface Window {
    readonly opennib: OpennibPreloadApi
  }
}

const STATE_LABEL: Record<PipelineState, string> = {
  idle: "READY",
  recording: "LISTENING",
  processing: "TRANSCRIBING",
}

// ─── DOM handles ──────────────────────────────────────────────────

const viewMain = document.getElementById("view-main")
const viewMic = document.getElementById("view-mic")
const viewLanguage = document.getElementById("view-language")
const statusLine = document.getElementById("status-line")
const hintPill = document.getElementById("hint-pill")
const trayToggle = document.getElementById("tray-toggle")
const qsMic = document.getElementById("qs-mic")
const qsMicValue = document.getElementById("qs-mic-value")
const qsLanguage = document.getElementById("qs-language")
const qsLanguageValue = document.getElementById("qs-language-value")
const micList = document.getElementById("mic-list")
const languageList = document.getElementById("language-list")
const showHistoryBtn = document.getElementById("show-history")
const insertLastBtn = document.getElementById("insert-last")
const showSettingsBtn = document.getElementById("show-settings")
const quitBtn = document.getElementById("quit")

// ─── local state ──────────────────────────────────────────────────

let currentSettings: SettingsSnapshot | null = null
let currentState: PipelineState = "idle"
let micDevices: MediaDeviceInfo[] = []

// ─── view switching ───────────────────────────────────────────────

type ViewName = "main" | "mic" | "language"

function showView(name: ViewName): void {
  for (const [el, n] of [
    [viewMain, "main"],
    [viewMic, "mic"],
    [viewLanguage, "language"],
  ] as const) {
    if (el !== null) el.hidden = n !== name
  }
}

// ─── rendering ────────────────────────────────────────────────────

function languageDisplay(tag: string): string {
  const match = SUPPORTED_LANGUAGES.find((l) => l.tag === tag)
  return match?.nativeName ?? tag.toUpperCase()
}

function micDisplay(deviceId: string | null): string {
  if (deviceId === null) return "System default"
  const found = micDevices.find((d) => d.deviceId === deviceId)
  if (found === undefined || found.label === "") return "Selected device"
  return found.label
}

function renderStatus(): void {
  if (statusLine === null || currentSettings === null) return
  const lang = currentSettings.language === "auto" ? "AUTO" : currentSettings.language.toUpperCase()
  if (!currentSettings.enabled) {
    statusLine.textContent = `OFF · ${lang}`
  } else {
    statusLine.textContent = `${STATE_LABEL[currentState]} · ${lang}`
  }
}

function renderToggle(): void {
  if (trayToggle === null || currentSettings === null) return
  const on = currentSettings.enabled
  trayToggle.classList.toggle("on", on)
  trayToggle.setAttribute("aria-checked", on ? "true" : "false")
  if (hintPill !== null) hintPill.classList.toggle("dimmed", !on)
}

function renderQuickValues(): void {
  if (currentSettings === null) return
  if (qsMicValue !== null) qsMicValue.textContent = micDisplay(currentSettings.selectedMicId)
  if (qsLanguageValue !== null) {
    qsLanguageValue.textContent = languageDisplay(currentSettings.language)
  }
}

function renderMicList(): void {
  if (micList === null || currentSettings === null) return
  micList.innerHTML = ""

  const rows: Array<{ id: string | null; primary: string; sub: string }> = [
    { id: null, primary: "System default", sub: "Follows macOS sound input" },
  ]
  for (const d of micDevices) {
    rows.push({
      id: d.deviceId,
      primary: d.label !== "" ? d.label : "Microphone",
      sub: d.kind,
    })
  }

  for (const row of rows) {
    const selected = row.id === currentSettings.selectedMicId
    const li = document.createElement("li")
    li.className = `picker-row${selected ? " selected" : ""}`
    li.innerHTML = `
      <svg class="picker-check" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M2.5 6.5L5 9l4.5-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="picker-body">
        <div class="picker-primary"></div>
        <div class="picker-sub"></div>
      </div>
    `
    const primary = li.querySelector(".picker-primary")
    const sub = li.querySelector(".picker-sub")
    if (primary !== null) primary.textContent = row.primary
    if (sub !== null) sub.textContent = row.sub
    li.addEventListener("click", () => {
      void window.opennib.settings.setSelectedMicId(row.id).then((next) => {
        applySettings(next)
        showView("main")
      })
    })
    micList.appendChild(li)
  }
}

function renderLanguageList(): void {
  if (languageList === null || currentSettings === null) return
  languageList.innerHTML = ""

  for (const lang of SUPPORTED_LANGUAGES) {
    const selected = lang.tag === currentSettings.language
    const li = document.createElement("li")
    li.className = `picker-row${selected ? " selected" : ""}`
    li.innerHTML = `
      <svg class="picker-check" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M2.5 6.5L5 9l4.5-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="picker-body">
        <div class="picker-primary"></div>
        <div class="picker-sub"></div>
      </div>
    `
    const primary = li.querySelector(".picker-primary")
    const sub = li.querySelector(".picker-sub")
    if (primary !== null) primary.textContent = lang.nativeName
    if (sub !== null && lang.displayName !== lang.nativeName) {
      sub.textContent = lang.displayName
    }
    li.addEventListener("click", () => {
      void window.opennib.settings.setLanguage(lang.tag).then((next) => {
        applySettings(next)
        showView("main")
      })
    })
    languageList.appendChild(li)
  }
}

// ─── update plumbing ──────────────────────────────────────────────

function applySettings(snapshot: SettingsSnapshot): void {
  currentSettings = snapshot
  renderStatus()
  renderToggle()
  renderQuickValues()
}

async function loadMicDevices(): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    // Chromium synthesises two extra aliases on top of the real devices:
    //   deviceId === "default"        → the current OS-default mic
    //   deviceId === "communications" → the OS communications mic (Win)
    // We already expose a virtual "System default" row that follows the OS,
    // so dropping these aliases prevents AirPods (or whatever the default
    // is) from appearing twice.
    micDevices = devices.filter(
      (d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications",
    )
  } catch {
    // enumerateDevices can fail before any mic permission has been granted —
    // keep whatever we have. The user can still pick "System default" or open
    // Settings to grant permission.
  }
}

async function refresh(): Promise<void> {
  try {
    const snapshot = await window.opennib.settings.get()
    await loadMicDevices()
    applySettings(snapshot)
  } catch {
    // Best-effort refresh; the popover is purely informational.
  }
}

// ─── wiring ───────────────────────────────────────────────────────

window.opennib.state.onChange((state) => {
  currentState = state
  renderStatus()
})

window.opennib.settings.onChange((snapshot) => {
  applySettings(snapshot)
})

window.opennib.tray.onShow(() => {
  void refresh()
})

if (trayToggle !== null) {
  trayToggle.addEventListener("click", () => {
    if (currentSettings === null) return
    const next = !currentSettings.enabled
    void window.opennib.settings.setEnabled(next).then(applySettings)
  })
}

if (qsMic !== null) {
  qsMic.addEventListener("click", () => {
    void loadMicDevices().then(() => {
      renderMicList()
      showView("mic")
    })
  })
}
if (qsLanguage !== null) {
  qsLanguage.addEventListener("click", () => {
    renderLanguageList()
    showView("language")
  })
}

for (const back of document.querySelectorAll<HTMLButtonElement>("[data-back]")) {
  back.addEventListener("click", () => showView("main"))
}

if (showHistoryBtn !== null) {
  showHistoryBtn.addEventListener("click", () => {
    window.opennib.tray.showSettings()
  })
}

if (insertLastBtn !== null) {
  insertLastBtn.addEventListener("click", () => {
    void window.opennib.tray.insertLast().catch(() => {
      // Best-effort; main process will surface failures via the system notifier.
    })
  })
}

if (showSettingsBtn !== null) {
  showSettingsBtn.addEventListener("click", () => {
    window.opennib.tray.showSettings()
  })
}
if (quitBtn !== null) {
  quitBtn.addEventListener("click", () => {
    window.opennib.tray.quit()
  })
}

void refresh()

export {}
