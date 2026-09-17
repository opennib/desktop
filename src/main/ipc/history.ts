import { ipcMain } from "electron"

import type { History } from "@opennib/core"

import { IPC_CHANNELS } from "../ipc-channels"

export function registerHistoryIpc(history: History): void {
  ipcMain.handle(IPC_CHANNELS.history.list, async (_event, raw: unknown) => {
    const limit =
      typeof raw === "object" &&
      raw !== null &&
      "limit" in raw &&
      typeof (raw as { limit?: unknown }).limit === "number" &&
      Number.isFinite((raw as { limit: number }).limit)
        ? (raw as { limit: number }).limit
        : undefined
    return history.list(limit !== undefined ? { limit } : undefined)
  })

  ipcMain.handle(IPC_CHANNELS.history.clear, async () => {
    await history.clear()
  })
}
