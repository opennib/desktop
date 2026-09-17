import { describe, expect, it, vi } from "vitest"

import { RecorderError } from "@opennib/core"

import { IPC_CHANNELS } from "../../../src/main/ipc-channels"
import {
  ElectronRecorderTransport,
  type IpcMainLike,
  type WebContentsLike,
} from "../../../src/main/services/electron-recorder-transport"

interface FakeIpcMain extends IpcMainLike {
  fire(channel: string, payload: unknown): void
  listeners: Map<string, (event: unknown, ...args: unknown[]) => void>
}

function createFakeIpcMain(): FakeIpcMain {
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  return {
    listeners,
    once(channel, listener) {
      listeners.set(channel, listener)
    },
    removeListener(channel) {
      listeners.delete(channel)
    },
    fire(channel, payload) {
      const listener = listeners.get(channel)
      if (listener === undefined) throw new Error(`no listener for ${channel}`)
      listeners.delete(channel)
      listener({}, payload)
    },
  }
}

describe("ElectronRecorderTransport", () => {
  it("signalStart sends the start channel", () => {
    const send = vi.fn()
    const ipcMain = createFakeIpcMain()
    const transport = new ElectronRecorderTransport({
      webContents: { send } satisfies WebContentsLike,
      ipcMain,
    })
    transport.signalStart()
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.recorder.start)
  })

  it("signalStop sends the stop channel", () => {
    const send = vi.fn()
    const ipcMain = createFakeIpcMain()
    const transport = new ElectronRecorderTransport({
      webContents: { send } satisfies WebContentsLike,
      ipcMain,
    })
    transport.signalStop()
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.recorder.stop)
  })

  it("awaitAudio resolves with the ArrayBuffer payload from ipcMain", async () => {
    const ipcMain = createFakeIpcMain()
    const transport = new ElectronRecorderTransport({
      webContents: { send: vi.fn() },
      ipcMain,
    })

    const buffer = new ArrayBuffer(16)
    const promise = transport.awaitAudio()
    ipcMain.fire(IPC_CHANNELS.recorder.audio, buffer)
    await expect(promise).resolves.toBe(buffer)
  })

  it("awaitAudio accepts a TypedArray payload by unwrapping its .buffer", async () => {
    const ipcMain = createFakeIpcMain()
    const transport = new ElectronRecorderTransport({
      webContents: { send: vi.fn() },
      ipcMain,
    })
    const samples = new Float32Array([0.1, -0.2, 0.3])
    const promise = transport.awaitAudio()
    ipcMain.fire(IPC_CHANNELS.recorder.audio, samples)
    const result = await promise
    expect(result).toBe(samples.buffer)
  })

  it("awaitAudio rejects with RecorderError when payload is not buffer-like", async () => {
    const ipcMain = createFakeIpcMain()
    const transport = new ElectronRecorderTransport({
      webContents: { send: vi.fn() },
      ipcMain,
    })

    const promise = transport.awaitAudio()
    ipcMain.fire(IPC_CHANNELS.recorder.audio, "garbage")
    await expect(promise).rejects.toBeInstanceOf(RecorderError)
  })

  it("awaitAudio registers a one-shot listener per call", async () => {
    const ipcMain = createFakeIpcMain()
    const transport = new ElectronRecorderTransport({
      webContents: { send: vi.fn() },
      ipcMain,
    })

    const first = transport.awaitAudio()
    expect(ipcMain.listeners.has(IPC_CHANNELS.recorder.audio)).toBe(true)
    ipcMain.fire(IPC_CHANNELS.recorder.audio, new ArrayBuffer(4))
    await first
    expect(ipcMain.listeners.has(IPC_CHANNELS.recorder.audio)).toBe(false)

    const second = transport.awaitAudio()
    expect(ipcMain.listeners.has(IPC_CHANNELS.recorder.audio)).toBe(true)
    ipcMain.fire(IPC_CHANNELS.recorder.audio, new ArrayBuffer(8))
    await second
  })
})
