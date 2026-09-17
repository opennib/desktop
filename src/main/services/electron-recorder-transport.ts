import { RecorderError } from "@opennib/core"

import { IPC_CHANNELS } from "../ipc-channels"
import type { RecorderTransport } from "./recorder"

/**
 * Tightest possible slice of Electron's WebContents we use, so the transport
 * is testable without booting a renderer.
 */
export interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void
}

/**
 * Tightest slice of Electron's ipcMain we use.
 */
export interface IpcMainLike {
  once(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void,
  ): void
  removeListener(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void,
  ): void
}

export interface ElectronRecorderTransportOptions {
  readonly webContents: WebContentsLike
  readonly ipcMain: IpcMainLike
}

export class ElectronRecorderTransport implements RecorderTransport {
  constructor(private readonly options: ElectronRecorderTransportOptions) {}

  signalStart(): void {
    this.options.webContents.send(IPC_CHANNELS.recorder.start)
  }

  signalStop(): void {
    this.options.webContents.send(IPC_CHANNELS.recorder.stop)
  }

  awaitAudio(): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const handler = (_event: unknown, ...args: unknown[]) => {
        const payload = args[0]
        if (payload instanceof ArrayBuffer) {
          resolve(payload)
        } else if (
          payload !== null &&
          typeof payload === "object" &&
          "buffer" in (payload as object) &&
          (payload as { buffer: unknown }).buffer instanceof ArrayBuffer
        ) {
          // Some IPC paths deliver TypedArrays whose .buffer is an ArrayBuffer.
          resolve((payload as { buffer: ArrayBuffer }).buffer)
        } else {
          reject(
            new RecorderError(
              `expected ArrayBuffer audio payload, got ${describePayload(payload)}`,
            ),
          )
        }
      }
      this.options.ipcMain.once(IPC_CHANNELS.recorder.audio, handler)
    })
  }
}

function describePayload(payload: unknown): string {
  if (payload === null) return "null"
  if (payload === undefined) return "undefined"
  return typeof payload === "object"
    ? (payload?.constructor?.name ?? "object")
    : typeof payload
}
