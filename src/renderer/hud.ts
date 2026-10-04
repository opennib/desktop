// Floating recording indicator. Hosted in a frameless, transparent,
// non-focusable BrowserWindow so the user's target app stays frontmost.
// The HUD listens to pipeline state and audio-level frames — it never
// sends back, so this script is tiny.
//
// We deliberately don't `declare global { Window.opennib }` here: main.ts
// already does that with the full preload surface, and re-declaring with a
// narrower shape in the same renderer tsconfig would conflict. We narrow at
// the access site instead.
type PipelineState = "idle" | "recording" | "processing"

import { hotkeyLabel } from "./platform"

interface HudPreloadShape {
  readonly state: {
    onChange(handler: (state: PipelineState) => void): () => void
  }
  readonly audio: {
    onLevel(handler: (bins: readonly number[]) => void): () => void
  }
  readonly settings: {
    get(): Promise<{ readonly hotkey: string }>
    onChange(handler: (snapshot: { readonly hotkey: string }) => void): () => void
  }
}

const pill = document.getElementById("pill")
const idleText = document.getElementById("idle-text")
const statusText = document.getElementById("status-text")
const waveformEl = document.getElementById("waveform")
const bars =
  waveformEl !== null ? Array.from(waveformEl.querySelectorAll<HTMLSpanElement>("span")) : []

// When the noise gate is closed (silence) or recording just started, bars
// should read as flat — the design says "play waveform when we hear the mic"
// and any visible floor reads as constant motion. CSS keeps a 1-px minimum
// via border-radius alone, so visually zero ≈ flat line.
const FLAT_AMPLITUDE = 0
let currentState: PipelineState = "idle"
let timerId: number | undefined
let recordingStartedAt = 0

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

function clearTimer(): void {
  if (timerId !== undefined) {
    window.clearInterval(timerId)
    timerId = undefined
  }
}

function setBarHeights(values: readonly number[]): void {
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]
    if (bar === undefined) continue
    const raw = values[i] ?? FLAT_AMPLITUDE
    // No floor: zeros from the recorder's noise gate must read as flat.
    // Cap at 1 so loud frames don't overflow the slot.
    const clamped = Math.min(1, Math.max(0, raw * 1.6))
    bar.style.setProperty("--h", clamped.toFixed(3))
  }
}

function flattenBars(): void {
  for (const bar of bars) bar.style.setProperty("--h", String(FLAT_AMPLITUDE))
}

function applyState(state: PipelineState): void {
  currentState = state
  if (pill !== null) pill.dataset["state"] = state

  if (state === "recording") {
    // Start flat: the recorder publishes zeros until the noise gate opens, so
    // any opening transient would otherwise paint as a loud spike here.
    flattenBars()
    recordingStartedAt = performance.now()
    if (statusText !== null) statusText.textContent = "0:00"
    clearTimer()
    timerId = window.setInterval(() => {
      if (statusText === null) return
      statusText.textContent = formatElapsed(performance.now() - recordingStartedAt)
    }, 250)
    return
  }

  clearTimer()
  if (statusText !== null) statusText.textContent = ""

  // Idle flattens; processing leaves bars frozen at whatever the last
  // recording frame left them at (CSS dims the parent at 0.35).
  if (state === "idle") flattenBars()
}

const api = (window as unknown as { opennib: HudPreloadShape }).opennib
api.state.onChange(applyState)
api.audio.onLevel((bins) => {
  // Only drive bars while actively recording. Processing freezes; idle is
  // hidden anyway by the main process via `setHudState`.
  if (currentState !== "recording") return
  setBarHeights(bins)
})

flattenBars()

// The idle pill names the configured push-to-talk key (fn on macOS, Right Alt
// on Windows by default) and follows changes made in Settings.
function renderIdleHint(combo: string): void {
  if (idleText !== null) idleText.textContent = `Hold ${hotkeyLabel(combo)} to dictate`
}
void api.settings.get().then((snapshot) => renderIdleHint(snapshot.hotkey))
api.settings.onChange((snapshot) => renderIdleHint(snapshot.hotkey))

export {}
