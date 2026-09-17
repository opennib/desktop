import {
  DEFAULT_LANGUAGE,
  DEFAULT_WHISPER_MODEL_ID,
  type LanguageTag,
  type ModelManager,
  type Settings,
  type SettingsSnapshot,
  type WhisperModelId,
} from "@opennib/core"
import { describe, expect, it, vi } from "vitest"

import {
  ModelController,
  type ModelProgressEvent,
} from "../../../src/main/services/model-controller"

class FakeModelManager implements ModelManager {
  installed = new Set<WhisperModelId>()
  pending = new Map<
    WhisperModelId,
    { resolve: () => void; reject: (e: unknown) => void; emit: (p: number) => void }
  >()
  removed: WhisperModelId[] = []

  async pathFor(id: string): Promise<string> {
    return `/tmp/${id}`
  }
  async isInstalled(id: string): Promise<boolean> {
    return this.installed.has(id as WhisperModelId)
  }
  download(id: string, onProgress?: (p: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.set(id as WhisperModelId, {
        resolve: () => {
          this.installed.add(id as WhisperModelId)
          resolve()
        },
        reject,
        emit: (percent: number) => onProgress?.(percent),
      })
    })
  }
  async remove(id: string): Promise<void> {
    this.installed.delete(id as WhisperModelId)
    this.removed.push(id as WhisperModelId)
  }
}

class FakeSettings implements Settings {
  private state: SettingsSnapshot = {
    whisperModelId: DEFAULT_WHISPER_MODEL_ID,
    language: DEFAULT_LANGUAGE,
    cleanupEnabled: false,
    llmModelId: null,
  }
  whisperModelId(): string {
    return this.state.whisperModelId
  }
  language(): LanguageTag {
    return this.state.language
  }
  cleanupEnabled(): boolean {
    return this.state.cleanupEnabled
  }
  llmModelId(): string | null {
    return this.state.llmModelId
  }
  snapshot(): SettingsSnapshot {
    return this.state
  }
  async setWhisperModelId(id: string): Promise<void> {
    this.state = { ...this.state, whisperModelId: id }
  }
  async setLanguage(language: LanguageTag): Promise<void> {
    this.state = { ...this.state, language }
  }
  async setCleanupEnabled(enabled: boolean): Promise<void> {
    this.state = { ...this.state, cleanupEnabled: enabled }
  }
  async setLlmModelId(id: string | null): Promise<void> {
    this.state = { ...this.state, llmModelId: id }
  }
  onChange(): () => void {
    return () => {}
  }
}

function makeController(): {
  controller: ModelController
  manager: FakeModelManager
  settings: FakeSettings
  events: ModelProgressEvent[]
} {
  const manager = new FakeModelManager()
  const settings = new FakeSettings()
  const events: ModelProgressEvent[] = []
  const controller = new ModelController({
    modelManager: manager,
    settings,
    emitProgress: (e) => events.push(e),
  })
  return { controller, manager, settings, events }
}

describe("ModelController", () => {
  it("lists every catalog entry with installed + active flags", async () => {
    const { controller, manager, settings } = makeController()
    manager.installed.add("base")
    await settings.setWhisperModelId("tiny")

    const entries = await controller.list()

    const tiny = entries.find((e) => e.id === "tiny")
    const base = entries.find((e) => e.id === "base")
    const small = entries.find((e) => e.id === "small")
    expect(tiny?.active).toBe(true)
    expect(tiny?.installed).toBe(false)
    expect(base?.active).toBe(false)
    expect(base?.installed).toBe(true)
    expect(small?.active).toBe(false)
    expect(small?.installed).toBe(false)
  })

  it("emits downloading progress and a final completed event", async () => {
    const { controller, manager, events } = makeController()
    const promise = controller.download("base")

    // Wait a tick so download() has registered the pending entry.
    await Promise.resolve()
    const pending = manager.pending.get("base")
    if (pending === undefined) throw new Error("download not registered")
    pending.emit(33)
    pending.emit(100)
    pending.resolve()
    await promise

    expect(events).toEqual([
      { modelId: "base", percent: 33, state: "downloading" },
      { modelId: "base", percent: 100, state: "downloading" },
      { modelId: "base", percent: 100, state: "completed" },
    ])
  })

  it("emits a failed event and rethrows when the download errors", async () => {
    const { controller, events } = makeController()
    const manager = (controller as unknown as { deps: { modelManager: FakeModelManager } }).deps
      .modelManager
    const promise = controller.download("base")
    await Promise.resolve()
    const pending = manager.pending.get("base")
    if (pending === undefined) throw new Error("download not registered")
    pending.reject(new Error("network down"))

    await expect(promise).rejects.toThrow("network down")
    expect(events).toEqual([
      { modelId: "base", percent: 0, state: "failed", error: "network down" },
    ])
  })

  it("piggy-backs concurrent download() calls onto the in-flight task", async () => {
    const { controller, manager } = makeController()
    const downloadSpy = vi.spyOn(manager, "download")

    const a = controller.download("base")
    const b = controller.download("base")
    expect(a).toBe(b)
    expect(downloadSpy).toHaveBeenCalledTimes(1)

    await Promise.resolve()
    manager.pending.get("base")?.resolve()
    await a
  })

  it("releases the in-flight slot once a download completes", async () => {
    const { controller, manager } = makeController()
    const first = controller.download("base")
    await Promise.resolve()
    manager.pending.get("base")?.resolve()
    await first

    const downloadSpy = vi.spyOn(manager, "download")
    const second = controller.download("base")
    await Promise.resolve()
    manager.pending.get("base")?.resolve()
    await second
    expect(downloadSpy).toHaveBeenCalledTimes(1)
  })

  it("refuses to remove a model while it is downloading", async () => {
    const { controller, manager } = makeController()
    const download = controller.download("base")
    await Promise.resolve()

    await expect(controller.remove("base")).rejects.toThrow(/while a download is in progress/)
    manager.pending.get("base")?.resolve()
    await download
  })

  it("removes installed models when no download is in flight", async () => {
    const { controller, manager } = makeController()
    manager.installed.add("base")

    await controller.remove("base")
    expect(manager.removed).toEqual(["base"])
    expect(manager.installed.has("base")).toBe(false)
  })

  it("rejects unknown model ids on download and remove", async () => {
    const { controller } = makeController()
    await expect(controller.download("not-a-model")).rejects.toThrow(/unknown model id/)
    await expect(controller.remove("not-a-model")).rejects.toThrow(/unknown model id/)
  })

  it("includes both whisper and llm entries in list output", async () => {
    const { controller } = makeController()
    const entries = await controller.list()
    const whisper = entries.filter((e) => e.kind === "whisper")
    const llm = entries.filter((e) => e.kind === "llm")
    expect(whisper.length).toBeGreaterThan(0)
    expect(llm.length).toBeGreaterThan(0)
    // Whisper rows carry multilingual; LLM rows do not.
    expect(whisper.every((e) => typeof e.multilingual === "boolean")).toBe(true)
    expect(llm.every((e) => e.multilingual === undefined)).toBe(true)
  })

  it("marks the active llm only when cleanup is enabled", async () => {
    const { controller, manager, settings } = makeController()
    manager.installed.add("qwen2.5-0.5b-instruct-q4" as WhisperModelId)
    await settings.setLlmModelId("qwen2.5-0.5b-instruct-q4")

    const off = await controller.list()
    const offRow = off.find((e) => e.id === "qwen2.5-0.5b-instruct-q4")
    expect(offRow?.active).toBe(false)

    await settings.setCleanupEnabled(true)
    const on = await controller.list()
    const onRow = on.find((e) => e.id === "qwen2.5-0.5b-instruct-q4")
    expect(onRow?.active).toBe(true)
  })
})
