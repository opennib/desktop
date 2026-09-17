import { describe, expect, it, vi } from "vitest"

import { RecorderError, WHISPER_SAMPLE_RATE_HZ } from "@opennib/core"

import { IpcRecorder, type RecorderTransport } from "../../../src/main/services/recorder"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function buf(samples: Float32Array): ArrayBuffer {
  const out = new ArrayBuffer(samples.byteLength)
  new Float32Array(out).set(samples)
  return out
}

describe("IpcRecorder", () => {
  it("signals start and resolves stop with the renderer's audio buffer", async () => {
    const audio = new Float32Array(WHISPER_SAMPLE_RATE_HZ) // 1s of zero samples
    const d = deferred<ArrayBuffer>()
    const transport: RecorderTransport = {
      signalStart: vi.fn(),
      signalStop: vi.fn(),
      awaitAudio: vi.fn(() => d.promise),
    }

    const rec = new IpcRecorder({ transport })
    await rec.start()

    expect(transport.signalStart).toHaveBeenCalledOnce()
    d.resolve(buf(audio))
    const frame = await rec.stop()

    expect(transport.signalStop).toHaveBeenCalledOnce()
    expect(frame.sampleRate).toBe(WHISPER_SAMPLE_RATE_HZ)
    expect(frame.samples.length).toBe(audio.length)
    expect(frame.durationMs).toBeCloseTo(1000, 0)
  })

  it("subscribes to the audio response BEFORE signaling start to avoid races", async () => {
    const order: string[] = []
    const transport: RecorderTransport = {
      signalStart: vi.fn(() => order.push("start")),
      signalStop: vi.fn(() => order.push("stop")),
      awaitAudio: vi.fn(() => {
        order.push("await")
        return Promise.resolve(new ArrayBuffer(0))
      }),
    }
    const rec = new IpcRecorder({ transport })
    await rec.start()
    expect(order).toEqual(["await", "start"])
  })

  it("rejects double start with RecorderError", async () => {
    const transport: RecorderTransport = {
      signalStart: vi.fn(),
      signalStop: vi.fn(),
      awaitAudio: vi.fn(() => new Promise<ArrayBuffer>(() => {})),
    }
    const rec = new IpcRecorder({ transport })
    await rec.start()
    await expect(rec.start()).rejects.toBeInstanceOf(RecorderError)
  })

  it("rejects stop before start with RecorderError", async () => {
    const transport: RecorderTransport = {
      signalStart: vi.fn(),
      signalStop: vi.fn(),
      awaitAudio: vi.fn(),
    }
    const rec = new IpcRecorder({ transport })
    await expect(rec.stop()).rejects.toBeInstanceOf(RecorderError)
  })

  it("can start a fresh session after stop completes", async () => {
    const audio = new Float32Array(8000) // 0.5s
    const transport: RecorderTransport = {
      signalStart: vi.fn(),
      signalStop: vi.fn(),
      awaitAudio: vi.fn(() => Promise.resolve(buf(audio))),
    }
    const rec = new IpcRecorder({ transport })

    await rec.start()
    await rec.stop()
    await expect(rec.start()).resolves.toBeUndefined()
  })

  it("wraps awaitAudio rejection as RecorderError with cause", async () => {
    const cause = new Error("renderer disconnected")
    const transport: RecorderTransport = {
      signalStart: vi.fn(),
      signalStop: vi.fn(),
      awaitAudio: vi.fn(() => Promise.reject(cause)),
    }
    const rec = new IpcRecorder({ transport })
    await rec.start()
    try {
      await rec.stop()
      throw new Error("expected RecorderError")
    } catch (err) {
      expect(err).toBeInstanceOf(RecorderError)
      expect((err as RecorderError).cause).toBe(cause)
    }
  })

  it("computes duration from sample count and configured sample rate", async () => {
    const samples = new Float32Array(48_000) // 3s at 16kHz
    const transport: RecorderTransport = {
      signalStart: vi.fn(),
      signalStop: vi.fn(),
      awaitAudio: vi.fn(() => Promise.resolve(buf(samples))),
    }
    const rec = new IpcRecorder({ transport, sampleRate: 16_000 })
    await rec.start()
    const frame = await rec.stop()
    expect(frame.durationMs).toBe(3000)
  })

  it("preserves the underlying audio bytes in the returned frame", async () => {
    const samples = new Float32Array([0.1, -0.2, 0.3, -0.4])
    const transport: RecorderTransport = {
      signalStart: vi.fn(),
      signalStop: vi.fn(),
      awaitAudio: vi.fn(() => Promise.resolve(buf(samples))),
    }
    const rec = new IpcRecorder({ transport })
    await rec.start()
    const frame = await rec.stop()
    expect(Array.from(frame.samples)).toEqual([
      0.1, -0.2, 0.3, -0.4,
    ].map((v) => Math.fround(v)))
  })
})
