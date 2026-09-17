// Renderer-side audio capture. Listens for IPC messages from main, captures
// 16kHz mono PCM via Web Audio + an AudioWorklet, and ships the concatenated
// Float32 buffer back to main when stop is requested.

const TARGET_SAMPLE_RATE = 16_000
// HUD waveform tuning. 20 Hz keeps IPC chatter low while still feeling
// responsive at 80ms CSS transitions; 22 bars matches the design source
// (`docs/design-references/.../desktop-frames.jsx` HUD).
const LEVEL_PUBLISH_INTERVAL_MS = 50
const VISUAL_BAR_COUNT = 22
// Noise gate driven by time-domain RMS. Raw amplitude varies a lot across
// mics — Bluetooth HFP mics (AirPods) report roughly 5× less than wired —
// so the thresholds sit low enough for AirPods and accept some leakage
// risk on the noisiest desktop mics. The worklet PCM (transcription) is
// untouched; this is visualizer-only.
//   MacBook built-in:  silence 0.003–0.005, speech 0.05–0.18
//   AirPods Pro:       silence 0.0005–0.002, speech 0.01–0.04
// Open 0.006, close 0.003 with a 200ms hold to ride out inter-word pauses.
const GATE_OPEN_RMS = 0.006
const GATE_CLOSE_RMS = 0.003
const GATE_HOLD_FRAMES = 4
const SETTLE_FRAMES = 3
// Pull the analyser's dB window in from the (-100..-30) default so silence
// maps near zero on the visual bars instead of ~0.7 of full scale.
const ANALYSER_MIN_DB = -70
const ANALYSER_MAX_DB = -20
// Diagnostic: when true, the noise gate is bypassed and we publish FFT bins
// every frame during recording. The frozen-waveform bug this was chasing was
// timer throttling in the hidden main window (fixed via backgroundThrottling:
// false in windows.ts), not the gate — keep the gate active.
const DEBUG_BYPASS_GATE = false

let audioContext: AudioContext | null = null
let mediaStream: MediaStream | null = null
let workletNode: AudioWorkletNode | null = null
let analyser: AnalyserNode | null = null
let levelTimer: number | undefined
let audioChunks: Float32Array[] = []
// `audioContext.close()` is async; we track the promise so the NEXT
// startCapture awaits it before allocating a fresh context. Without this,
// session N+1 can race with session N's teardown — the analyser ends up
// attached to a stream whose source is being torn down, and produces
// silence even though the worklet (separate path) still captures fine.
let pendingClose: Promise<void> | null = null

async function startCapture(): Promise<void> {
  if (audioContext !== null) return

  // Wait for the previous session's context to finish closing before we
  // open the next one — see comment on `pendingClose`.
  if (pendingClose !== null) {
    await pendingClose.catch(() => undefined)
    pendingClose = null
  }

  audioChunks = []

  const snapshot = await window.opennib.settings.get()
  const deviceId = snapshot.selectedMicId
  const audioConstraints: MediaTrackConstraints = {
    channelCount: 1,
    sampleRate: TARGET_SAMPLE_RATE,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: true,
  }
  if (deviceId !== null) {
    audioConstraints.deviceId = { exact: deviceId }
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraints,
  })

  audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
  // Some Chromium states leave a freshly-created context in "suspended" —
  // the analyser tap then sees no signal even though the worklet path runs.
  // resume() is a no-op when already "running".
  if (audioContext.state !== "running") {
    await audioContext.resume()
  }
  await audioContext.audioWorklet.addModule("audio-worklet.js")

  const source = audioContext.createMediaStreamSource(mediaStream)
  workletNode = new AudioWorkletNode(audioContext, "pcm-capture")
  workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    audioChunks.push(new Float32Array(event.data))
  }

  source.connect(workletNode)
  workletNode.connect(audioContext.destination)
  workletNode.port.postMessage("start")

  // Tap the same source with an AnalyserNode for the HUD waveform. Read-only;
  // doesn't touch the PCM the worklet captures for transcription. Larger
  // fftSize widens the time-domain window so RMS is stable across the 50ms
  // publish interval; tight dB window pulls the visual bins from "silence
  // near zero" to "speech near full". Time-domain RMS drives the gate,
  // independent of the dB mapping.
  analyser = audioContext.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.5
  analyser.minDecibels = ANALYSER_MIN_DB
  analyser.maxDecibels = ANALYSER_MAX_DB
  source.connect(analyser)
  const fftBuffer = new Uint8Array(analyser.frequencyBinCount)
  const timeBuffer = new Float32Array(analyser.fftSize)
  const zeros = new Array<number>(VISUAL_BAR_COUNT).fill(0)
  let frameIndex = 0
  let gateOpen = false
  let holdFramesRemaining = 0
  levelTimer = window.setInterval(() => {
    if (analyser === null) return
    frameIndex += 1

    // Drop the first frames — AGC-ramp transients that look like a loud
    // spike before the user has even spoken.
    if (frameIndex <= SETTLE_FRAMES) {
      window.opennib.audio.publishLevel(zeros)
      return
    }

    // Time-domain RMS for the gate (direct amplitude, robust units).
    analyser.getFloatTimeDomainData(timeBuffer)
    let sq = 0
    for (let i = 0; i < timeBuffer.length; i++) {
      const v = timeBuffer[i] ?? 0
      sq += v * v
    }
    const rms = Math.sqrt(sq / timeBuffer.length)

    if (DEBUG_BYPASS_GATE) {
      gateOpen = true
    } else {
      if (rms > GATE_OPEN_RMS) {
        gateOpen = true
        holdFramesRemaining = GATE_HOLD_FRAMES
      } else if (gateOpen && rms < GATE_CLOSE_RMS) {
        if (holdFramesRemaining > 0) holdFramesRemaining -= 1
        else gateOpen = false
      }
      if (!gateOpen) {
        window.opennib.audio.publishLevel(zeros)
        return
      }
    }

    // Visual bin heights for the 22 bars (speech band, skipping DC).
    analyser.getByteFrequencyData(fftBuffer)
    const out = new Array<number>(VISUAL_BAR_COUNT)
    for (let i = 0; i < VISUAL_BAR_COUNT; i++) {
      out[i] = (fftBuffer[i + 1] ?? 0) / 255
    }
    window.opennib.audio.publishLevel(out)
  }, LEVEL_PUBLISH_INTERVAL_MS)
}

function stopCapture(): ArrayBuffer {
  if (levelTimer !== undefined) {
    window.clearInterval(levelTimer)
    levelTimer = undefined
  }
  analyser = null
  if (workletNode !== null) {
    workletNode.port.postMessage("stop")
  }
  if (mediaStream !== null) {
    for (const track of mediaStream.getTracks()) track.stop()
    mediaStream = null
  }

  const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Float32Array(totalLength)
  let offset = 0
  for (const chunk of audioChunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  audioChunks = []

  if (audioContext !== null) {
    pendingClose = audioContext.close()
    audioContext = null
  }
  workletNode = null

  // Force a freshly-allocated ArrayBuffer (not a view onto a longer buffer)
  // so structured cloning over IPC sends only the audio bytes.
  const out = new ArrayBuffer(merged.byteLength)
  new Float32Array(out).set(merged)
  return out
}

export function installRecorder(): void {
  window.opennib.recorder.onStart(() => {
    startCapture().catch((err) => {
      console.error("recorder start failed", err)
    })
  })
  window.opennib.recorder.onStop(() => {
    try {
      const buffer = stopCapture()
      window.opennib.recorder.sendAudio(buffer)
    } catch (err) {
      console.error("recorder stop failed", err)
    }
  })
}
