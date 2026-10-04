import type {
  ModelEntry,
  ModelProgressEvent,
  OpennibPreloadApi,
  PipelineState,
  SystemStatusSnapshot,
} from "../shared/preload-api"
import { IS_MAC, IS_WIN, probeMicrophone } from "./platform"

declare global {
  interface Window {
    readonly opennib: OpennibPreloadApi
  }
}

type PermissionState = "granted" | "denied" | "undetermined"
type StepName = "welcome" | "acc" | "mic" | "model" | "lang" | "try" | "done"

// Accessibility is a macOS concept; Windows and Linux paste without it, so
// the step is dropped there and the pips, labels and navigation follow.
const STEP_ORDER: readonly StepName[] = IS_MAC
  ? ["welcome", "acc", "mic", "model", "lang", "try", "done"]
  : ["welcome", "mic", "model", "lang", "try", "done"]

/**
 * Curated language menu for the onboarding picker. We don't expose the full
 * 99 Whisper-supported tags here — the core list (`SUPPORTED_LANGUAGES`) is
 * already opinionated about which ones the smaller models handle reliably.
 * Hard-coded here as a string table to avoid pulling the core enum into the
 * renderer (no `@opennib/core` imports in renderer code).
 */
interface LangRow {
  readonly tag: string
  readonly name: string
  readonly native: string
}

const LANGUAGES: readonly LangRow[] = [
  { tag: "en", name: "English", native: "English" },
  { tag: "es", name: "Spanish", native: "Español" },
  { tag: "fr", name: "French", native: "Français" },
  { tag: "de", name: "German", native: "Deutsch" },
  { tag: "it", name: "Italian", native: "Italiano" },
  { tag: "pt", name: "Portuguese", native: "Português" },
  { tag: "nl", name: "Dutch", native: "Nederlands" },
  { tag: "pl", name: "Polish", native: "Polski" },
  { tag: "ru", name: "Russian", native: "Русский" },
  { tag: "ja", name: "Japanese", native: "日本語" },
  { tag: "ko", name: "Korean", native: "한국어" },
  { tag: "zh", name: "Chinese", native: "中文" },
  { tag: "ar", name: "Arabic", native: "العربية" },
  { tag: "hi", name: "Hindi", native: "हिन्दी" },
  { tag: "vi", name: "Vietnamese", native: "Tiếng Việt" },
  { tag: "tr", name: "Turkish", native: "Türkçe" },
  { tag: "uk", name: "Ukrainian", native: "Українська" },
]

/**
 * Quality + speed bars per model id. The bars are editorial, not measured —
 * they communicate the "bigger = better, slower" tradeoff at a glance. Same
 * shape as the design source.
 */
interface ModelMeta {
  readonly quality: number
  readonly speed: number
  readonly desc: string
  readonly recommended?: boolean
}

const MODEL_META: Readonly<Record<string, ModelMeta>> = {
  tiny: { quality: 1, speed: 5, desc: "Fastest. Casual notes." },
  "tiny.en": { quality: 1, speed: 5, desc: "Fastest. English only." },
  base: { quality: 2, speed: 4, desc: "Quick and decent." },
  "base.en": { quality: 2, speed: 4, desc: "Quick. English only." },
  small: {
    quality: 3,
    speed: 3,
    desc: "Recommended. Balanced.",
    recommended: true,
  },
  "small.en": { quality: 3, speed: 3, desc: "Balanced. English only." },
  medium: { quality: 4, speed: 2, desc: "Slower, much better at names." },
  "medium.en": { quality: 4, speed: 2, desc: "Slower. English only." },
  "large-v3": { quality: 5, speed: 1, desc: "Best quality. Slowest." },
  "large-v3-turbo": {
    quality: 4,
    speed: 4,
    desc: "Medium quality at Small speed. Newer.",
  },
}

const FALLBACK_META: ModelMeta = { quality: 3, speed: 3, desc: "" }

// Display labels for the supported push-to-talk combos. Mirror of the table
// in main.ts so the onboarding bundle doesn't have to import from the main
// settings panel.
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

const KEY_CODE_TO_COMBO: Readonly<Record<string, string>> = {
  ControlLeft: "LeftCtrl",
  AltRight: "RightAlt",
  AltLeft: "LeftAlt",
  ControlRight: "RightCtrl",
  MetaRight: "RightCmd",
  ScrollLock: "ScrollLock",
  F8: "F8",
  F9: "F9",
}

/**
 * Two keys on each half of the keyboard, none of them held during normal
 * typing. On macOS F8/F9 are media keys on Apple keyboards (no key code
 * without fn) and Right Control is absent on laptop keyboards, so they are
 * not offered there; Windows/Linux keep the plain-key set.
 */
function platformHotkeyPresets(): readonly string[] {
  return IS_MAC
    ? ["Fn", "LeftCtrl", "RightAlt", "RightCmd"]
    : ["RightAlt", "LeftAlt", "RightCtrl", "ScrollLock", "F8", "F9"]
}

interface State {
  step: StepName
  models: readonly ModelEntry[]
  selectedModelId: string
  selectedLang: string
  autoDetect: boolean
  pollTimer: number | null
  tryMode: boolean
  unsubState: (() => void) | null
  unsubTranscript: (() => void) | null
  unsubProgress: (() => void) | null
  unsubSettings: (() => void) | null
  pendingDownloadModelId: string | null
  currentHotkey: string
  /** True between "recording" and the transcript (or idle without one). */
  awaitingTranscript: boolean
  /**
   * Result of the renderer-side microphone probe on Windows/Linux, where the
   * main process cannot ask. Overrides an "undetermined" snapshot.
   */
  micProbe: PermissionState | null
  micProbeLabel: string | null
}

const state: State = {
  step: "welcome",
  models: [],
  selectedModelId: "",
  selectedLang: "en",
  autoDetect: false,
  pollTimer: null,
  tryMode: false,
  unsubState: null,
  unsubTranscript: null,
  unsubProgress: null,
  unsubSettings: null,
  pendingDownloadModelId: null,
  currentHotkey: "Fn",
  awaitingTranscript: false,
  micProbe: null,
  micProbeLabel: null,
}

// ─── DOM helpers ──────────────────────────────────────────────────────

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function $$(selector: string): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>(selector)
}

function isStepName(value: unknown): value is StepName {
  return typeof value === "string" && (STEP_ORDER as readonly string[]).includes(value)
}

function pane(step: StepName): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-pane="${step}"]`)
}

function footSet(step: StepName): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-foot="${step}"]`)
}

function bind(id: string, handler: () => void): void {
  const el = $(id)
  if (el === null) return
  el.addEventListener("click", handler)
}

// ─── Step transitions ─────────────────────────────────────────────────

function setStep(next: StepName): void {
  // Tear down try-mode state when leaving step 6 so the wrapped paster
  // resumes pasting into the focused app.
  if (state.step === "try" && next !== "try") {
    void disableTryMode()
  }
  state.step = next
  // Persist progress so a relaunch (macOS asks for one after some grants)
  // resumes here instead of at step 1.
  void window.opennib.onboarding.setStep(next)
  for (const s of STEP_ORDER) {
    const p = pane(s)
    if (p !== null) p.hidden = s !== next
    const f = footSet(s)
    if (f !== null) f.hidden = s !== next
  }
  const idx = STEP_ORDER.indexOf(next)
  const stepLabel = pane(next)?.querySelector<HTMLElement>(".ob-step-label")
  if (stepLabel !== null && stepLabel !== undefined) {
    stepLabel.textContent = `Step ${idx + 1} of ${STEP_ORDER.length}`
  }
  $$(".ob-pip").forEach((dot, i) => {
    dot.classList.toggle("is-active", i === idx)
    dot.classList.toggle("is-done", i < idx)
  })
  const pipsContainer = $("ob-pips")
  if (pipsContainer !== null) {
    pipsContainer.setAttribute("aria-valuenow", String(idx + 1))
  }

  stopAccessibilityPoll()
  if (next === "acc" || next === "mic" || next === "try" || next === "done") {
    startAccessibilityPoll()
  }
  if (next === "try") {
    void enableTryMode()
  }
}

// ─── Permission status (acc + mic) ────────────────────────────────────

function setPillStatus(el: HTMLElement, state: PermissionState, label: string): void {
  el.dataset["state"] = state
  const labelEl = el.querySelector<HTMLElement>(".ob-pill-label")
  if (labelEl !== null) labelEl.textContent = label
}

function updateAccPane(snapshot: SystemStatusSnapshot): void {
  const status = $("ob-acc-status")
  const openBtn = $<HTMLButtonElement>("ob-acc-open")
  const nextBtn = $<HTMLButtonElement>("ob-acc-next")
  const laterBtn = $<HTMLButtonElement>("ob-acc-later")
  if (status === null || openBtn === null || nextBtn === null || laterBtn === null) return

  // On non-mac platforms accessibility is `null`. Treat it as granted so the
  // user can advance — the runtime adapters handle pasting differently there.
  const perm: PermissionState = snapshot.accessibility ?? "granted"
  const label =
    perm === "granted"
      ? "Accessibility granted"
      : perm === "denied"
        ? "Accessibility denied"
        : "Waiting for permission…"
  setPillStatus(status, perm, label)

  if (perm === "granted") {
    openBtn.hidden = true
    laterBtn.hidden = true
    nextBtn.hidden = false
  } else {
    openBtn.hidden = false
    laterBtn.hidden = false
    nextBtn.hidden = true
  }
}

function updateMicPane(snapshot: SystemStatusSnapshot): void {
  const status = $("ob-mic-status")
  const reqBtn = $<HTMLButtonElement>("ob-mic-request")
  const openBtn = $<HTMLButtonElement>("ob-mic-open")
  const nextBtn = $<HTMLButtonElement>("ob-mic-next")
  if (status === null || reqBtn === null || openBtn === null || nextBtn === null) return

  const perm = effectiveMicrophone(snapshot)
  const label =
    perm === "granted"
      ? "Microphone granted"
      : perm === "denied"
        ? (state.micProbeLabel ?? "Microphone denied")
        : "Not granted yet"
  setPillStatus(status, perm, label)

  if (perm === "granted") {
    reqBtn.hidden = true
    openBtn.hidden = true
    nextBtn.hidden = false
  } else if (perm === "denied") {
    // The system prompt only fires the first time; once denied, the user
    // must toggle it in system settings. Continue stays available so they
    // can finish onboarding and revisit later. Linux has no settings pane
    // to open, so only the Continue button is offered there.
    reqBtn.hidden = true
    openBtn.hidden = !(IS_MAC || IS_WIN)
    nextBtn.hidden = false
  } else {
    reqBtn.hidden = false
    openBtn.hidden = true
    nextBtn.hidden = true
  }
}

function effectiveMicrophone(snapshot: SystemStatusSnapshot): PermissionState {
  if (snapshot.microphone === "granted") return "granted"
  return state.micProbe ?? snapshot.microphone
}

async function requestMicrophone(): Promise<void> {
  if (IS_MAC) {
    const snap = await window.opennib.system.requestMicrophone()
    updateMicPane(snap)
    return
  }
  const result = await probeMicrophone()
  state.micProbe = result.state
  state.micProbeLabel = result.label
  await refreshPermissionStatus()
}

/** Copy and chrome that differ off macOS: no Accessibility step, tray not menu bar. */
function applyPlatformChrome(): void {
  if (IS_MAC) return
  document.querySelector<HTMLElement>(`.ob-pip[data-pip="${STEP_ORDER.length + 1}"]`)?.remove()
  $("ob-pips")?.setAttribute("aria-valuemax", String(STEP_ORDER.length))
  const home = $("ob-done-home")
  if (home !== null) home.textContent = "system tray"
  const micOpen = $("ob-mic-open")
  if (micOpen !== null) micOpen.textContent = "Open Settings"
}

let pollTimer: number | null = null

function startAccessibilityPoll(): void {
  const tick = (): void => {
    void window.opennib.system.status().then((snap) => {
      updateAccPane(snap)
      updateMicPane(snap)
      updateKeyboardAccess(snap)
    })
  }
  tick()
  pollTimer = window.setInterval(tick, 1000)
}

function stopAccessibilityPoll(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

async function refreshPermissionStatus(): Promise<void> {
  const snap = await window.opennib.system.status()
  updateAccPane(snap)
  updateMicPane(snap)
}

// ─── Step 4 · Model picker ────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`
  return `${bytes} B`
}

function meterMarkup(value: number, kind: "ink" | "rec"): string {
  const cls = kind === "rec" ? "is-on-rec" : "is-on"
  let html = ""
  for (let i = 1; i <= 5; i++) {
    const on = i <= value ? cls : ""
    html += `<span class="ob-meter-bar ${on}"></span>`
  }
  return html
}

function renderModelList(): void {
  const host = $("ob-model-list")
  if (host === null) return

  // Surface whisper models only — the picker is specifically the Whisper
  // model. LLM cleaner picker lives in main settings.
  const whisperModels = state.models.filter((m) => m.kind === "whisper")

  host.innerHTML = whisperModels
    .map((m) => {
      const meta = MODEL_META[m.id] ?? FALLBACK_META
      const sel = m.id === state.selectedModelId
      const recBadge = meta.recommended ? `<span class="ob-chip rec">Recommended</span>` : ""
      const installedBadge = m.installed ? `<span class="ob-model-installed">Installed</span>` : ""
      return `
        <div class="ob-model-row ${sel ? "is-selected" : ""}" data-model-id="${m.id}" role="radio" aria-checked="${sel}">
          <span class="ob-model-radio"><span class="ob-model-radio-dot"></span></span>
          <div class="ob-model-main">
            <div class="ob-model-title">
              <span class="ob-model-name">${m.displayName}</span>
              ${recBadge}
              ${installedBadge}
            </div>
            <div class="ob-model-desc">${meta.desc}</div>
          </div>
          <div class="ob-model-meter">
            <div class="ob-meter-block">
              <div class="ob-meter-label mono">Quality</div>
              <div class="ob-meter-bars">${meterMarkup(meta.quality, "ink")}</div>
            </div>
            <div class="ob-meter-block">
              <div class="ob-meter-label mono">Speed</div>
              <div class="ob-meter-bars">${meterMarkup(meta.speed, "rec")}</div>
            </div>
          </div>
          <span class="ob-model-size mono">${formatSize(m.approxSizeBytes)}</span>
        </div>
      `
    })
    .join("")

  host.querySelectorAll<HTMLElement>(".ob-model-row").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset["modelId"]
      if (id === undefined) return
      state.selectedModelId = id
      renderModelList()
      updateModelFoot()
    })
  })
  updateModelFoot()
}

function updateModelFoot(): void {
  const sizeEl = $("ob-model-size")
  const nextBtn = $<HTMLButtonElement>("ob-model-next")
  const selected = state.models.find((m) => m.id === state.selectedModelId)
  if (sizeEl !== null && selected !== undefined) {
    sizeEl.textContent = `~${formatSize(selected.approxSizeBytes)}`
  }
  if (nextBtn !== null && selected !== undefined) {
    nextBtn.textContent = selected.installed ? "Continue →" : "Download & continue →"
  }
}

async function handleModelNext(): Promise<void> {
  const selected = state.models.find((m) => m.id === state.selectedModelId)
  if (selected === undefined) {
    setStep("lang")
    return
  }
  const nextBtn = $<HTMLButtonElement>("ob-model-next")
  await window.opennib.settings.setModel(selected.id)

  if (!selected.installed && nextBtn !== null) {
    state.pendingDownloadModelId = selected.id
    nextBtn.disabled = true
    nextBtn.textContent = "Downloading…"
    try {
      await window.opennib.models.download(selected.id)
    } catch {
      // Surface failure inline; the user can still advance to language since
      // the model load attempt will retry on first dictation.
      nextBtn.disabled = false
      nextBtn.textContent = "Retry download"
      return
    }
    nextBtn.disabled = false
  }
  setStep("lang")
}

function attachModelProgress(): void {
  if (state.unsubProgress !== null) return
  state.unsubProgress = window.opennib.models.onProgress((event: ModelProgressEvent) => {
    if (state.pendingDownloadModelId !== event.modelId) return
    const nextBtn = $<HTMLButtonElement>("ob-model-next")
    if (nextBtn === null) return
    if (event.state === "downloading") {
      nextBtn.textContent = `Downloading… ${Math.max(0, Math.round(event.percent))}%`
    } else if (event.state === "completed") {
      nextBtn.textContent = "Continue →"
    } else if (event.state === "failed") {
      nextBtn.textContent = "Retry download"
      nextBtn.disabled = false
    }
  })
}

// ─── Step 5 · Language picker ─────────────────────────────────────────

function renderLanguageGrid(): void {
  const host = $("ob-lang-grid")
  if (host === null) return
  host.innerHTML = LANGUAGES.map((l) => {
    const sel = l.tag === state.selectedLang && !state.autoDetect
    return `
      <div class="ob-lang-row ${sel ? "is-selected" : ""}" data-lang="${l.tag}" role="radio" aria-checked="${sel}">
        <span class="ob-lang-code">${l.tag}</span>
        <div class="ob-lang-body">
          <div class="ob-lang-name">${l.name}</div>
          <div class="ob-lang-native">${l.native}</div>
        </div>
      </div>
    `
  }).join("")
  host.querySelectorAll<HTMLElement>(".ob-lang-row").forEach((row) => {
    row.addEventListener("click", () => {
      const tag = row.dataset["lang"]
      if (tag === undefined) return
      state.selectedLang = tag
      state.autoDetect = false
      syncAutoDetectSwitch()
      renderLanguageGrid()
    })
  })
}

function syncAutoDetectSwitch(): void {
  const sw = $("ob-autodetect-switch")
  if (sw === null) return
  sw.setAttribute("aria-checked", state.autoDetect ? "true" : "false")
}

async function handleLangNext(): Promise<void> {
  const tag = state.autoDetect ? "auto" : state.selectedLang
  await window.opennib.settings.setLanguage(tag)
  setStep("try")
}

// ─── Step 6 · Try-it-out ──────────────────────────────────────────────

function renderTryHotkeyLabel(combo: string): void {
  state.currentHotkey = combo
  const label = HOTKEY_KEY_LABELS[combo] ?? combo
  for (const id of [
    "ob-try-prompt-key",
    "ob-try-card-key",
    "ob-try-area-key",
    "ob-done-key",
    "ob-done-quickref-key",
  ]) {
    const el = $(id)
    if (el !== null) el.textContent = label
  }
}

function closeTryPicker(): void {
  const picker = $("ob-try-picker")
  if (picker !== null) picker.hidden = true
  // Restore "Press a key…" state for next open.
  const stateEl = $("ob-trypicker-state")
  if (stateEl !== null) {
    stateEl.textContent = "Press a key…"
    stateEl.classList.remove("is-error")
  }
}

function openTryPicker(): void {
  const picker = $("ob-try-picker")
  if (picker === null) return
  // Build presets fresh each open so the current selection is highlighted.
  const presets = $("ob-trypicker-presets")
  if (presets !== null) {
    presets.innerHTML = ""
    for (const combo of platformHotkeyPresets()) {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = `ob-trypicker-preset${combo === state.currentHotkey ? " is-current" : ""}`
      btn.textContent = HOTKEY_KEY_LABELS[combo] ?? combo
      btn.dataset["combo"] = combo
      btn.addEventListener("click", () => {
        void window.opennib.settings.setHotkey(combo).then(() => {
          closeTryPicker()
        })
      })
      presets.appendChild(btn)
    }
  }
  const stateEl = $("ob-trypicker-state")
  if (stateEl !== null) {
    stateEl.textContent = "Press a key…"
    stateEl.classList.remove("is-error")
  }
  picker.hidden = false
}

function handleTryPickerKey(e: KeyboardEvent): void {
  const picker = $("ob-try-picker")
  if (picker === null || picker.hidden) return
  if (e.key === "Escape") {
    e.preventDefault()
    closeTryPicker()
    return
  }
  if (e.key === "Enter" || e.key === "Tab") return
  const combo = KEY_CODE_TO_COMBO[e.code]
  if (combo === undefined) {
    e.preventDefault()
    const stateEl = $("ob-trypicker-state")
    if (stateEl !== null) {
      stateEl.textContent = `${e.key} isn't supported`
      stateEl.classList.add("is-error")
    }
    return
  }
  e.preventDefault()
  void window.opennib.settings.setHotkey(combo).then(() => {
    closeTryPicker()
  })
}

/**
 * Show the Input Monitoring callouts (try + done steps) while the hotkey
 * helper reports it cannot see keystrokes yet. Hidden for "granted" and for
 * "unknown" (adapters that can't report, or the pipeline not started yet).
 */
function updateKeyboardAccess(snapshot: SystemStatusSnapshot): void {
  const waiting = snapshot.keyboardAccess === "waiting"
  for (const id of ["ob-try-keyaccess", "ob-done-keyaccess"]) {
    const el = $(id)
    if (el !== null) el.hidden = !waiting
  }
}

async function enableTryMode(): Promise<void> {
  if (state.tryMode) return
  state.tryMode = true
  await window.opennib.onboarding.setTryMode(true)
  // Reset visuals so a previous successful try doesn't linger when the user
  // navigates back into step 6.
  setTryAreaState("idle")
  setTryFeedback("idle")

  state.unsubState = window.opennib.state.onChange((s: PipelineState) => {
    if (s === "recording") {
      state.awaitingTranscript = true
      setTryAreaState("recording")
      setTryFeedback("idle")
    } else if (s === "processing") {
      setTryAreaState("recording")
    } else if (s === "idle" && state.awaitingTranscript) {
      // The cycle ended without a transcript: the speech gate found nothing
      // to transcribe (silence, or a tap too short to be an utterance).
      state.awaitingTranscript = false
      setTryAreaState("idle")
      setTryFeedback("nothing")
    }
    // success state is driven by transcript arrival, not pipeline state —
    // we want the transcript text visible, not a flicker back to idle.
  })

  state.unsubTranscript = window.opennib.onboarding.onTranscript((text: string) => {
    state.awaitingTranscript = false
    const out = $("ob-try-text")
    if (out !== null) out.textContent = text
    setTryAreaState("success")
    setTryFeedback("success")
  })
}

async function disableTryMode(): Promise<void> {
  if (!state.tryMode) return
  state.tryMode = false
  state.unsubState?.()
  state.unsubState = null
  state.unsubTranscript?.()
  state.unsubTranscript = null
  await window.opennib.onboarding.setTryMode(false)
}

function setTryAreaState(s: "idle" | "recording" | "success"): void {
  const area = $("ob-try-area")
  if (area === null) return
  area.dataset["state"] = s
}

function setTryFeedback(s: "idle" | "success" | "nothing"): void {
  const fb = $("ob-try-feedback")
  if (fb === null) return
  fb.dataset["state"] = s
  const idle = fb.querySelector<HTMLElement>(".ob-tryfeedback-idle")
  const nothing = fb.querySelector<HTMLElement>(".ob-tryfeedback-nothing")
  const succ = fb.querySelector<HTMLElement>(".ob-tryfeedback-success")
  if (idle !== null) idle.hidden = s !== "idle"
  if (nothing !== null) nothing.hidden = s !== "nothing"
  if (succ !== null) succ.hidden = s !== "success"
}

// ─── Init ─────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  await refreshPermissionStatus()

  const settings = await window.opennib.settings.get()
  state.selectedModelId = settings.whisperModelId
  if (settings.language === "auto") {
    state.autoDetect = true
    state.selectedLang = "en"
  } else {
    state.autoDetect = false
    state.selectedLang = settings.language
  }
  syncAutoDetectSwitch()
  renderTryHotkeyLabel(settings.hotkey)

  // Subscribe to settings changes so the Try-it-out labels reflect the
  // current hotkey if it gets changed mid-onboarding.
  state.unsubSettings = window.opennib.settings.onChange((snap) => {
    renderTryHotkeyLabel(snap.hotkey)
  })

  state.models = await window.opennib.models.list()
  attachModelProgress()
  renderModelList()
  renderLanguageGrid()
  applyPlatformChrome()

  // Resume where a previous session left off (see setStep persistence).
  const saved = settings.onboardingStep
  if (isStepName(saved) && saved !== "welcome") setStep(saved)

  // Footer bindings — kept inline so wiring is in one place.

  // Step 1
  bind("ob-quit", () => {
    // No quit IPC channel — just close the window. Electron will quit on
    // window-all-closed for non-mac platforms; on mac the tray keeps the
    // process alive, which matches Wispr Flow's "menu-bar app" model.
    window.close()
  })
  bind("ob-welcome-next", () => setStep(IS_MAC ? "acc" : "mic"))

  // Step 2
  bind("ob-acc-skip", () => setStep("mic"))
  bind("ob-acc-later", () => setStep("mic"))
  bind("ob-acc-open", () => {
    void window.opennib.system.openSettings("accessibility")
  })
  bind("ob-acc-next", () => setStep("mic"))

  // Step 3
  bind("ob-mic-back", () => setStep(IS_MAC ? "acc" : "welcome"))
  bind("ob-mic-request", () => {
    void requestMicrophone()
  })
  bind("ob-mic-open", () => {
    void window.opennib.system.openSettings("microphone")
  })
  bind("ob-mic-next", () => setStep("model"))

  // Step 4
  bind("ob-model-back", () => setStep("mic"))
  bind("ob-model-next", () => {
    void handleModelNext()
  })

  // Step 5
  bind("ob-lang-back", () => setStep("model"))
  bind("ob-lang-next", () => {
    void handleLangNext()
  })
  const autoSwitch = $("ob-autodetect-switch")
  if (autoSwitch !== null) {
    const toggle = (): void => {
      state.autoDetect = !state.autoDetect
      syncAutoDetectSwitch()
      renderLanguageGrid()
    }
    autoSwitch.addEventListener("click", toggle)
    autoSwitch.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault()
        toggle()
      }
    })
  }

  // Step 6
  bind("ob-try-keyaccess-open", () => {
    void window.opennib.system.openSettings("input-monitoring")
  })
  bind("ob-done-keyaccess-open", () => {
    void window.opennib.system.openSettings("input-monitoring")
  })
  bind("ob-try-back", () => setStep("lang"))
  bind("ob-try-next", () => setStep("done"))
  bind("ob-try-change", openTryPicker)
  bind("ob-trypicker-cancel", closeTryPicker)
  document.addEventListener("keydown", handleTryPickerKey)

  // Step 7
  bind("ob-done-settings", () => {
    void window.opennib.onboarding.complete()
  })
  bind("ob-finish", () => {
    void window.opennib.onboarding.complete()
  })
}

void init()
