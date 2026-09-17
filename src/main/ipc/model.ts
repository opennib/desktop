import { ipcMain } from "electron"

import { IPC_CHANNELS } from "../ipc-channels"
import type { ModelController } from "../services/model-controller"

export function registerModelIpc(controller: ModelController): void {
  ipcMain.handle(IPC_CHANNELS.models.list, () => controller.list())

  ipcMain.handle(IPC_CHANNELS.models.download, async (_event, modelId: unknown) => {
    if (typeof modelId !== "string") {
      throw new Error(`model id must be a string, got ${typeof modelId}`)
    }
    await controller.download(modelId)
  })

  ipcMain.handle(IPC_CHANNELS.models.remove, async (_event, modelId: unknown) => {
    if (typeof modelId !== "string") {
      throw new Error(`model id must be a string, got ${typeof modelId}`)
    }
    await controller.remove(modelId)
  })
}
