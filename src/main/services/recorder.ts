import {
  RecorderError,
  WHISPER_SAMPLE_RATE_HZ,
  log,
  type AudioFrame,
  type Recorder,
} from "@opennib/core"

/**
 * The renderer captures audio via Web Audio + an AudioWorklet, then ships the
 * Float32 PCM buffer to main when stop is requested. The Recorder adapter in
 * main is therefore a thin coordinator over an IPC transport.
 *
 * Tests inject a fake transport so the adapter is exercised without Electron.
 */
export interface RecorderTransport {
  signalStart(): void
  signalStop(): void
  /**
   * Resolves with the raw PCM buffer the renderer captured for the current
   * recording session. Implementations should resolve only the next response
   * (one-shot listener) and reject on transport failure or timeout.
   */
  awaitAudio(): Promise<ArrayBuffer>
}

export interface IpcRecorderOptions {
  readonly transport: RecorderTransport
  readonly sampleRate?: number
}

export class IpcRecorder implements Recorder {
  private readonly transport: RecorderTransport
  private readonly sampleRate: number
  private pending: Promise<ArrayBuffer> | null = null

  constructor(options: IpcRecorderOptions) {
    this.transport = options.transport
    this.sampleRate = options.sampleRate ?? WHISPER_SAMPLE_RATE_HZ
  }

  async start(): Promise<void> {
    if (this.pending !== null) {
      throw new RecorderError("recorder already started")
    }
    let pending: Promise<ArrayBuffer>
    try {
      pending = this.transport.awaitAudio()
      this.transport.signalStart()
    } catch (cause) {
      this.pending = null
      throw new RecorderError("failed to start recorder", cause)
    }
    this.pending = pending
  }

  async stop(): Promise<AudioFrame> {
    const pending = this.pending
    if (pending === null) {
      throw new RecorderError("recorder not started")
    }
    try {
      this.transport.signalStop()
    } catch (cause) {
      this.pending = null
      throw new RecorderError("failed to signal stop", cause)
    }

    let buffer: ArrayBuffer
    try {
      buffer = await pending
    } catch (cause) {
      this.pending = null
      throw new RecorderError("failed to receive audio from renderer", cause)
    }
    this.pending = null

    const samples = new Float32Array(buffer)
    const durationMs = (samples.length / this.sampleRate) * 1000
    const stats = audioStats(samples)
    log.info("captured audio frame", {
      samples: samples.length,
      durationMs: Math.round(durationMs),
      sampleRate: this.sampleRate,
      peak: stats.peak,
      rms: stats.rms,
    })
    return { samples, sampleRate: this.sampleRate, durationMs }
  }
}

function audioStats(samples: Float32Array): { peak: number; rms: number } {
  if (samples.length === 0) return { peak: 0, rms: 0 }
  let peak = 0
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0
    const abs = Math.abs(v)
    if (abs > peak) peak = abs
    sumSq += v * v
  }
  return {
    peak: round4(peak),
    rms: round4(Math.sqrt(sumSq / samples.length)),
  }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}
