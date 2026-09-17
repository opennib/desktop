import {
  isLlmModelId,
  isWhisperModelId,
  listLlmModels,
  listWhisperModels,
  type ModelManager,
  type Settings,
} from "@opennib/core"

export type ModelKindId = "whisper" | "llm"

export interface ModelEntry {
  readonly id: string
  readonly kind: ModelKindId
  readonly displayName: string
  readonly approxSizeBytes: number
  /** Whisper-only metadata; absent for LLM rows. */
  readonly multilingual?: boolean
  readonly installed: boolean
  readonly active: boolean
  readonly downloading: boolean
}

export interface ModelProgressEvent {
  readonly modelId: string
  readonly percent: number
  readonly state: "downloading" | "completed" | "failed"
  readonly error?: string
}

export interface ModelControllerDeps {
  readonly modelManager: ModelManager
  readonly settings: Settings
  readonly emitProgress: (event: ModelProgressEvent) => void
}

/**
 * Coordinates model download / removal for the renderer.
 *
 * Wraps `ModelManager` with two extras the UI needs and the manager doesn't
 * provide: in-flight tracking (so a second click on Download for the same id
 * piggy-backs on the existing fetch instead of starting a parallel one), and
 * a push channel for terminal state — the manager itself only signals
 * progress mid-stream, not completion or failure.
 *
 * Handles both Whisper (transcription) and LLM (cleanup) models. The UI
 * groups them by `kind`; download / remove dispatches off the same id space
 * because both id namespaces are disjoint.
 */
export class ModelController {
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(private readonly deps: ModelControllerDeps) {}

  async list(): Promise<readonly ModelEntry[]> {
    const activeWhisperId = this.deps.settings.whisperModelId()
    const activeLlmId = this.deps.settings.cleanupEnabled()
      ? this.deps.settings.llmModelId()
      : null

    const whisperEntries = await Promise.all(
      listWhisperModels().map(async (m): Promise<ModelEntry> => ({
        id: m.id,
        kind: "whisper",
        displayName: m.displayName,
        approxSizeBytes: m.approxSizeBytes,
        multilingual: m.multilingual,
        installed: await this.deps.modelManager.isInstalled(m.id),
        active: m.id === activeWhisperId,
        downloading: this.inFlight.has(m.id),
      })),
    )

    const llmEntries = await Promise.all(
      listLlmModels().map(async (m): Promise<ModelEntry> => ({
        id: m.id,
        kind: "llm",
        displayName: m.displayName,
        approxSizeBytes: m.approxSizeBytes,
        installed: await this.deps.modelManager.isInstalled(m.id),
        active: m.id === activeLlmId,
        downloading: this.inFlight.has(m.id),
      })),
    )

    return [...whisperEntries, ...llmEntries]
  }

  download(modelId: string): Promise<void> {
    if (!this.isKnown(modelId)) {
      return Promise.reject(new Error(`unknown model id: ${modelId}`))
    }
    const existing = this.inFlight.get(modelId)
    if (existing !== undefined) return existing

    const task = (async () => {
      try {
        await this.deps.modelManager.download(modelId, (percent) => {
          this.deps.emitProgress({ modelId, percent, state: "downloading" })
        })
        this.deps.emitProgress({ modelId, percent: 100, state: "completed" })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.deps.emitProgress({ modelId, percent: 0, state: "failed", error: message })
        throw err
      } finally {
        this.inFlight.delete(modelId)
      }
    })()

    this.inFlight.set(modelId, task)
    return task
  }

  async remove(modelId: string): Promise<void> {
    if (!this.isKnown(modelId)) {
      throw new Error(`unknown model id: ${modelId}`)
    }
    if (this.inFlight.has(modelId)) {
      throw new Error(`cannot remove ${modelId} while a download is in progress`)
    }
    await this.deps.modelManager.remove(modelId)
  }

  private isKnown(modelId: string): boolean {
    return isWhisperModelId(modelId) || isLlmModelId(modelId)
  }
}
