import { join } from "node:path"

import { BrowserWindow, Notification, app, systemPreferences } from "electron"

import {
  isLlmModelId,
  log,
  type Cleaner,
  type Dictionary,
  type ModelManager,
  type Paster,
  type SettingsSnapshot,
} from "@opennib/core"

import { errorMessage } from "./error-message"
import type { ModelLoadError } from "./ipc/system"
import { IPC_CHANNELS } from "./ipc-channels"
import { createPaster, defaultHotkeyForPlatform } from "./platform-adapters"
import {
  CoreWorkerClient,
  type RpcDictionaryHandle,
  type RpcHistoryHandle,
  type RpcTranscriberHandle,
} from "./services/core-worker"
import { ModelController } from "./services/model-controller"
import { FsModelManager, LLM_MODEL_KIND, WHISPER_MODEL_KIND } from "./services/model-manager"
import { ElectronNotifier } from "./services/notifier"
import { ElectronPermissions } from "./services/permissions"
import { JsonFileSettings } from "./services/settings"
import { ElectronStorage } from "./services/storage"

/**
 * Mutable holder for the LLM cleaner. The cleaner can be swapped at
 * runtime when the user toggles cleanup or picks a different LLM model
 * in settings, so we keep one stable handle that the pipeline reads
 * via `current()` per recording cycle.
 *
 * The cleaner itself now lives in the core worker; this handle owns only the
 * decision of WHICH model should be loaded and drives the worker over RPC.
 */
export interface CleanerHandle {
  current(): Cleaner | null
  /**
   * Build the cleaner that matches `snapshot` (or unload the previous
   * one if cleanup is disabled / no model picked / model not installed).
   * Safe to call repeatedly.
   */
  rebuild(snapshot: SettingsSnapshot): Promise<void>
  /** Unload any active cleaner. Called from teardown. */
  dispose(): Promise<void>
}

export interface PreparedServices {
  readonly storage: ElectronStorage
  readonly permissions: ElectronPermissions
  readonly settings: JsonFileSettings
  readonly modelManager: FsModelManager
  readonly modelController: ModelController
  readonly transcriber: RpcTranscriberHandle
  readonly cleaner: CleanerHandle
  readonly paster: Paster
  readonly notifier: ElectronNotifier
  readonly history: RpcHistoryHandle
  readonly dictionary: RpcDictionaryHandle
  /** The core-worker client — held so teardown can dispose it last. */
  readonly coreWorker: CoreWorkerClient
  /**
   * Last-known load error for the active whisper model, or null if the most
   * recent preload succeeded. Surfaced in the readiness banner with a
   * Re-download CTA, since the SDK error itself ("vector", "FAILED_TO_ACTIVATE")
   * doesn't tell the user what to do.
   */
  readonly modelLoadError: () => ModelLoadError | null
}

/**
 * Build the cleaner handle. The RPC cleaner adapter is a stable singleton; the
 * handle tracks whether a model is currently loaded and calls
 * `client.configureCleaner(...)` to load/unload inside the worker.
 */
function createCleanerHandle(modelManager: ModelManager, client: CoreWorkerClient): CleanerHandle {
  const rpcCleaner = client.cleaner()
  let active: Cleaner | null = null

  async function unloadActive(): Promise<void> {
    if (active === null) return
    active = null
    try {
      await client.configureCleaner(null)
    } catch (err) {
      log.warn("cleaner unload failed", { error: errorMessage(err) })
    }
  }

  return {
    current: () => active,
    async rebuild(snapshot) {
      const wantId =
        snapshot.cleanupEnabled && snapshot.llmModelId !== null && isLlmModelId(snapshot.llmModelId)
          ? snapshot.llmModelId
          : null
      if (wantId === null) {
        await unloadActive()
        return
      }
      if (!(await modelManager.isInstalled(wantId))) {
        log.warn("cleanup enabled but LLM model not installed; cleaner stays off", {
          llmModelId: wantId,
        })
        await unloadActive()
        return
      }
      const modelPath = await modelManager.pathFor(wantId)
      await client.configureCleaner(modelPath)
      active = rpcCleaner
      log.info("LLM cleaner ready", { llmModelId: wantId })
    },
    dispose: unloadActive,
  }
}

export async function prepareServices(
  getWindow: () => BrowserWindow | undefined,
): Promise<PreparedServices> {
  const storage = new ElectronStorage(app)
  const permissions = new ElectronPermissions({
    platform: process.platform,
    systemPreferences,
  })

  const settings = new JsonFileSettings({
    filePath: join(storage.baseDirectory(), "settings.json"),
    defaultHotkey: defaultHotkeyForPlatform(),
  })
  await settings.load()

  const modelManager = new FsModelManager({
    baseDir: storage.baseDirectory(),
    kinds: [WHISPER_MODEL_KIND, LLM_MODEL_KIND],
  })
  const installed = await modelManager.isInstalled(settings.whisperModelId())
  if (!installed) {
    log.warn("whisper model not installed", { modelId: settings.whisperModelId() })
  }

  // Boot the core worker: a Bare subprocess that hosts the AI engines and
  // Hypercore stores, driven from here over bare-rpc. Electron main never
  // loads whisper/llama native binaries or holds the corestore fd-locks now.
  //
  // The worker script sits at `bare/core-worker.mjs` under the app root. In
  // dev `app.getAppPath()` is this package directory; in a packaged build it
  // is `Contents/Resources/app`, a real directory because the app ships
  // unarchived (`asar: false`) with `bare/**` in the builder's file list, so
  // one path expression serves both.
  const coreWorker = new CoreWorkerClient()
  await coreWorker.start({
    workerPath: join(app.getAppPath(), "bare", "core-worker.mjs"),
    historyDir: join(storage.baseDirectory(), "history"),
    dictionaryDir: join(storage.baseDirectory(), "dictionary"),
    socketDir: app.getPath("temp"),
  })

  // The transcriber routes through the SDK's filePath/ffmpeg decode path
  // (WAV encoder in the worker) — the raw-buffer base64 batch path returns
  // empty text on the current SDK + whispercpp versions. The reference implementation
  // uses the same WAV/filePath pattern.
  const transcriber = coreWorker.transcriber()

  // Tracks the most recent preload outcome for the active whisper model.
  // Cleared on success, set on failure. Surfaced via system.status so the
  // renderer can render an appropriate message + CTA in the readiness
  // banner. `kind` lets the renderer distinguish actually-bad-file errors
  // (where "Re-download" helps) from config-validation errors (where it
  // doesn't), so the UI stops claiming "may be corrupt" for parameter bugs.
  let activeModelLoadError: ModelLoadError | null = null

  // Preload the active whisper model at startup so the first Fn-press doesn't
  // block on a 75MB–2.9GB load. Best-effort: a failure here shouldn't prevent
  // the app from booting (the user can still download or switch models from
  // the UI), but it should be visible in the log so we know preload didn't
  // happen.
  if (installed) {
    try {
      const modelPath = await modelManager.pathFor(settings.whisperModelId())
      const language = settings.language()
      const t0 = Date.now()
      await transcriber.preload(modelPath, language)
      log.info("whisper model preloaded", {
        modelId: settings.whisperModelId(),
        language,
        loadMs: Date.now() - t0,
      })
      activeModelLoadError = null
    } catch (err) {
      log.warn("whisper model preload failed", { error: errorMessage(err) })
      activeModelLoadError = {
        modelId: settings.whisperModelId(),
        message: errorMessage(err),
        kind: classifyLoadError(err),
      }
    }
  }

  const cleaner = createCleanerHandle(modelManager, coreWorker)
  try {
    await cleaner.rebuild(settings.snapshot())
  } catch (err) {
    log.warn("initial cleaner build failed", { error: errorMessage(err) })
  }
  if (cleaner.current() === null) {
    log.info("LLM cleaner disabled (enable in Preferences and pick a model)")
  }

  const paster = createPaster()

  const notifier = new ElectronNotifier((options) => new Notification(options))

  const history = coreWorker.history()
  const dictionary = coreWorker.dictionary()

  const modelController = new ModelController({
    modelManager,
    settings,
    emitProgress: (event) => {
      const w = getWindow()
      if (w === undefined || w.isDestroyed()) return
      w.webContents.send(IPC_CHANNELS.models.progress, event)
    },
  })

  // Broadcast settings changes to every live BrowserWindow so the tray
  // popover and any future window keep their UI in sync without polling.
  // The renderer consumes the combined dictation + host view, so broadcast
  // the app snapshot (not core's dictation-only slice).
  settings.onAppChange((snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send(IPC_CHANNELS.settings.change, snapshot)
    }
  })

  // Language changes don't trigger a reload here. The transcriber caches by
  // (modelPath, language), so the next transcribe() after the user switches
  // language naturally misses the cache and loads the new context. Verified
  // on mobile 2026-05-16: changing the picker mid-session is picked up by
  // the next utterance without any explicit reload — the prior assumption
  // that @qvac/sdk held a single context shared across languages was wrong.

  // Rebuild the LLM cleaner when the user toggles cleanup or picks a
  // different model. Other settings changes (whisperModel, language)
  // don't touch the cleaner, so we gate on the two fields that do.
  let activeCleanupEnabled = settings.cleanupEnabled()
  let activeLlmModelId = settings.llmModelId()
  settings.onChange((snapshot) => {
    if (
      snapshot.cleanupEnabled === activeCleanupEnabled &&
      snapshot.llmModelId === activeLlmModelId
    ) {
      return
    }
    activeCleanupEnabled = snapshot.cleanupEnabled
    activeLlmModelId = snapshot.llmModelId
    void cleaner.rebuild(snapshot).catch((err: unknown) => {
      log.warn("cleaner rebuild failed", { error: errorMessage(err) })
    })
  })

  return {
    storage,
    permissions,
    settings,
    modelManager,
    modelController,
    transcriber,
    cleaner,
    paster,
    notifier,
    history,
    dictionary,
    coreWorker,
    modelLoadError: () => activeModelLoadError,
  }
}

/**
 * Decide whether a whisper preload failure looks like a bad file (re-download
 * may help) or a config-validation rejection (re-download won't help).
 *
 * The native @qvac/transcription-whispercpp binding surfaces parameter
 * validation as `error in <field> handler: ... <field> must be <constraint>`,
 * which historically rendered as "the file may be corrupt" in the UI because
 * the renderer treated any `FAILED_TO_ACTIVATE` as corruption. Splitting these
 * so the message is honest and the CTA only appears when it could help.
 */
function classifyLoadError(err: unknown): ModelLoadError["kind"] {
  const message = errorMessage(err)
  // Validator messages: "error in <X> handler:" or "<field> must be ...".
  // These come from parameter validation; the file is fine.
  if (/error in \w+ handler:|\bmust be\b/i.test(message)) return "config"
  const name = err instanceof Error ? err.name : ""
  // Known signals for actually-bad files. The whispercpp addon emits the
  // bare word "vector" when its weight loader fails; ENOENT covers missing
  // files; FAILED_TO_LOAD_WEIGHTS is the SDK's explicit weight-load failure.
  if (name === "FAILED_TO_LOAD_WEIGHTS") return "file"
  if (/\bvector\b|ENOENT|no such file/i.test(message)) return "file"
  return "unknown"
}
