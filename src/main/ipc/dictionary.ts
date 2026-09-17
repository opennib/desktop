import { ipcMain } from "electron"

import type { Dictionary } from "@opennib/core"

import { IPC_CHANNELS } from "../ipc-channels"

export function registerDictionaryIpc(dictionary: Dictionary): void {
  ipcMain.handle(IPC_CHANNELS.dictionary.list, () => dictionary.list())

  ipcMain.handle(IPC_CHANNELS.dictionary.add, async (_event, raw: unknown) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("dictionary entry must be an object")
    }
    const candidate = raw as {
      id?: unknown
      term?: unknown
      replacement?: unknown
      createdAt?: unknown
    }
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      throw new Error("dictionary entry id must be a non-empty string")
    }
    if (typeof candidate.term !== "string" || candidate.term.trim().length === 0) {
      throw new Error("dictionary entry term must be a non-empty string")
    }
    if (typeof candidate.createdAt !== "number" || !Number.isFinite(candidate.createdAt)) {
      throw new Error("dictionary entry createdAt must be a finite number")
    }
    if (candidate.replacement !== undefined && typeof candidate.replacement !== "string") {
      throw new Error("dictionary entry replacement must be a string when provided")
    }
    const entry =
      candidate.replacement !== undefined && candidate.replacement.length > 0
        ? {
            id: candidate.id,
            term: candidate.term.trim(),
            replacement: candidate.replacement.trim(),
            createdAt: candidate.createdAt,
          }
        : { id: candidate.id, term: candidate.term.trim(), createdAt: candidate.createdAt }
    await dictionary.add(entry)
  })

  ipcMain.handle(IPC_CHANNELS.dictionary.remove, async (_event, id: unknown) => {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("dictionary entry id must be a non-empty string")
    }
    await dictionary.remove(id)
  })

  ipcMain.handle(IPC_CHANNELS.dictionary.clear, async () => {
    await dictionary.clear()
  })
}
