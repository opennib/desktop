import { BrowserWindow, Notification, Tray, app, dialog, globalShortcut, ipcMain } from "electron"

import { log, type Paster } from "@opennib/core"

import { registerDictionaryIpc } from "./ipc/dictionary"
import { registerHistoryIpc } from "./ipc/history"
import { registerModelIpc } from "./ipc/model"
import { emitOnboardingTranscript, registerOnboardingIpc } from "./ipc/onboarding"
import { registerSettingsIpc } from "./ipc/settings"
import { registerSystemIpc } from "./ipc/system"
import { IPC_CHANNELS } from "./ipc-channels"
import { TEARDOWN_HARD_TIMEOUT_MS, makeTeardownOnce } from "./lifecycle"
import { prepareServices } from "./prepare-services"
import type { AppSettingsSnapshot } from "./services/settings"
import { startPipeline, type RunningPipeline } from "./start-pipeline"
import {
  createHudWindow,
  createOnboardingWindow,
  createTray,
  createTrayWindow,
  createWindow,
  positionTrayWindow,
  setHudState,
  showMainWindow,
} from "./windows"

let mainWindow: BrowserWindow | undefined
let hudWindow: BrowserWindow | undefined
let trayWindow: BrowserWindow | undefined
let onboardingWindow: BrowserWindow | undefined
let tray: Tray | undefined
let running: RunningPipeline | null = null
let isQuitting = false

// Refuse to run a second instance against the same user-data-dir. Without
// this guard two simultaneous Electron processes race for the same Hypercore
// fd-locks under `~/Library/Application Support/@opennib/desktop`: whichever
// process opens `history/` and `dictionary/` first wins, and the other one
// throws `failed to open hypercore` on every `list`/`append`. In dev that
// happens whenever electron-vite restarts before the previous Electron has
// fully exited (the SIGTERM handler below normally handles it, but a hung
// teardown leaves the locks held).
//
// `requestSingleInstanceLock()` MUST be called before `app.whenReady()` for
// the second instance to exit synchronously. If we lose the race we quit
// immediately so the user-data-dir locks stay clean.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

/**
 * Apply startup-related preferences to the running app: login item (auto-launch)
 * and dock visibility on macOS. Called at boot and on every settings change so
 * a toggle in General → Startup takes effect immediately without a relaunch.
 */
function applyStartupPreferences(snapshot: AppSettingsSnapshot): void {
  try {
    app.setLoginItemSettings({ openAtLogin: snapshot.launchAtLogin })
  } catch (err) {
    // setLoginItemSettings is a no-op on platforms without a known registry
    // path (some Linux distros). Don't crash boot if it throws.
    log.warn("setLoginItemSettings failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (process.platform === "darwin") {
    if (snapshot.showInDock) {
      void app.dock?.show()
    } else {
      app.dock?.hide()
    }
  }
}
app.on("second-instance", () => {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    showMainWindow(mainWindow)
  }
})

const teardownOnce = makeTeardownOnce(
  () => running,
  () => {
    running = null
  },
)

void app.whenReady().then(async () => {
  log.info("opennib desktop main process ready")

  // Build services and register IPC handlers BEFORE the renderer can call
  // them. The window getter resolves lazily for push events.
  //
  // A failure here (core worker won't spawn, storage locked, …) would
  // otherwise become an unhandled rejection: the app lingers in the dock
  // with no tray and no window, and a user who installed a build has no way
  // to see why. Surface it in a native dialog and exit.
  let services: Awaited<ReturnType<typeof prepareServices>>
  try {
    services = await prepareServices(() => mainWindow)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error("startup failed", { error: message })
    dialog.showErrorBox("opennib could not start", message)
    app.quit()
    return
  }

  // Apply the user's startup preferences. macOS defaults to hidden dock
  // (paste-helper requires the focused-app target to stay frontmost) and no
  // login-item. Both can be flipped from Settings → General → Startup.
  applyStartupPreferences(services.settings.appSnapshot())
  services.settings.onAppChange((snap) => applyStartupPreferences(snap))
  registerSettingsIpc(services.settings)
  registerModelIpc(services.modelController)
  registerHistoryIpc(services.history)
  registerDictionaryIpc(services.dictionary)
  registerSystemIpc({
    permissions: services.permissions,
    modelManager: services.modelManager,
    settings: services.settings,
    modelLoadError: services.modelLoadError,
    keyboardAccess: () => running?.keyboardAccess() ?? "unknown",
  })
  registerOnboardingIpc({
    settings: services.settings,
    getWindow: () => onboardingWindow,
    onTryModeEnter: () => {
      void ensurePipeline()
    },
    onComplete: () => {
      if (onboardingWindow !== undefined && !onboardingWindow.isDestroyed()) {
        onboardingWindow.close()
        onboardingWindow = undefined
      }
      void ensurePipeline()
      showMainWindow(mainWindow)
    },
    onReset: () => {
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
        mainWindow.hide()
      }
      if (onboardingWindow === undefined || onboardingWindow.isDestroyed()) {
        onboardingWindow = createOnboardingWindow()
      } else {
        onboardingWindow.show()
        onboardingWindow.focus()
      }
    },
  })

  // Try-it-out (onboarding step 6) reuses the real dictation pipeline so the
  // user hears their own voice processed end-to-end. The transcript must
  // land in the onboarding window rather than the focused app, though — at
  // this point the user is following along inside our window, not typing
  // somewhere else. We intercept by wrapping the platform paster: while
  // try-mode is on the onboarding IPC swallows the transcript; otherwise we
  // fall through to the real paste-helper.
  const tryModePaster: Paster = {
    async paste(text: string): Promise<void> {
      if (emitOnboardingTranscript(text)) return
      await services.paster.paste(text)
    },
  }

  // First launch: show the onboarding window instead of the main shell.
  // The main window still loads in the background so the renderer is warm by
  // the time onboarding completes; we just keep it hidden via `shouldShowOnReady`
  // until `onboarding.complete` fires and `showMainWindow` is invoked.
  const isOnboarding = !services.settings.onboardingCompleted()
  mainWindow = createWindow({
    isQuitting: () => isQuitting,
    shouldShowOnReady: () => !isOnboarding,
  })
  hudWindow = createHudWindow()
  trayWindow = createTrayWindow()

  if (isOnboarding) {
    onboardingWindow = createOnboardingWindow()
  }

  const toggleTrayPopover = (): void => {
    if (trayWindow === undefined || tray === undefined) return
    if (trayWindow.isVisible()) {
      trayWindow.hide()
      return
    }
    positionTrayWindow(trayWindow, tray)
    trayWindow.webContents.send(IPC_CHANNELS.tray.show)
    trayWindow.show()
    trayWindow.focus()
  }

  tray = createTray({
    onTrayClick: toggleTrayPopover,
    onQuit: () => {
      isQuitting = true
      app.quit()
    },
  })

  // Forward audio-level frames from the recorder renderer to the HUD window
  // so the waveform reflects what the mic actually hears. Cheap: ~20 frames/s
  // of 22 floats. Dropped silently if the HUD is gone (idle window is hidden).
  ipcMain.on(IPC_CHANNELS.audio.level, (_event, bins) => {
    if (hudWindow === undefined || hudWindow.isDestroyed()) return
    hudWindow.webContents.send(IPC_CHANNELS.audio.level, bins)
  })

  ipcMain.on(IPC_CHANNELS.tray.hide, () => {
    if (trayWindow !== undefined && !trayWindow.isDestroyed()) trayWindow.hide()
  })
  ipcMain.on(IPC_CHANNELS.tray.quit, () => {
    isQuitting = true
    app.quit()
  })
  /** Bring the main window forward, optionally on a specific tab. */
  const showMainTab = (tab?: unknown): void => {
    if (trayWindow !== undefined && !trayWindow.isDestroyed()) trayWindow.hide()
    showMainWindow(mainWindow)
    if (typeof tab === "string" && mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.main.showTab, tab)
    }
  }

  const insertLastTranscript = async (): Promise<{ readonly inserted: boolean }> => {
    const recent = await services.history.list({ limit: 1 })
    const last = recent[0]
    if (last === undefined) return { inserted: false }
    if (trayWindow !== undefined && !trayWindow.isDestroyed()) trayWindow.hide()
    await services.paster.paste(last.text)
    return { inserted: true }
  }

  ipcMain.on(IPC_CHANNELS.tray.showSettings, (_event, tab: unknown) => showMainTab(tab))
  ipcMain.handle(IPC_CHANNELS.tray.insertLast, () => insertLastTranscript())

  // The shortcuts the onboarding "You're set" screen advertises.
  for (const [accelerator, action] of [
    ["Alt+Shift+H", () => showMainTab("history")],
    [
      "Alt+Shift+V",
      () => {
        void insertLastTranscript().catch((err) => {
          log.warn("insert last transcript failed", {
            error: err instanceof Error ? err.message : String(err),
          })
        })
      },
    ],
  ] as const) {
    if (!globalShortcut.register(accelerator, action)) {
      log.warn("global shortcut registration failed", { accelerator })
    }
  }
  app.on("will-quit", () => globalShortcut.unregisterAll())

  // Start the Fn hotkey + recorder bridge. The recorder transport needs a
  // real webContents, so this waits for the main renderer. During onboarding
  // it runs when the user reaches Try-it-out (see onTryModeEnter) rather than
  // at boot, so the OS prompts the helper triggers (Input Monitoring) appear
  // on the screen that explains them.
  let pipelineStart: Promise<void> | null = null
  async function ensurePipeline(): Promise<void> {
    if (running !== null) return
    if (pipelineStart !== null) return pipelineStart
    pipelineStart = (async () => {
      const win = mainWindow
      if (win === undefined || win.isDestroyed()) return
      await new Promise<void>((resolve) => {
        if (win.webContents.isLoading()) {
          win.webContents.once("did-finish-load", () => resolve())
        } else {
          resolve()
        }
      })
      running = await startPipeline({
        services: { ...services, paster: tryModePaster },
        window: win,
        onStateChange: (state) => {
          // Every renderer that shows pipeline state listens on this channel:
          // the main window, and the onboarding window's Try-it-out step.
          for (const win of BrowserWindow.getAllWindows()) {
            if (win === hudWindow || win.isDestroyed()) continue
            win.webContents.send(IPC_CHANNELS.state.change, state)
          }
          setHudState(hudWindow, state)
        },
      })
    })().finally(() => {
      pipelineStart = null
    })
    return pipelineStart
  }

  if (!isOnboarding) await ensurePipeline()

  // Menu-bar hint notification. Suppressed during onboarding because the
  // onboarding window already communicates the same information in-context
  // — surfacing it as a system notification on top of step 1 is just noise.
  if (!isOnboarding) {
    try {
      new Notification({
        title: "opennib",
        body: "Running in the menu bar. Hold Fn to dictate.",
      }).show()
    } catch {
      // Notifications can fail before user has granted permission; non-fatal.
    }
  }

  app.on("activate", () => {
    showMainWindow(mainWindow)
  })
})

app.on("before-quit", (event) => {
  // Mark intent so the main window's `close` handler stops trapping the
  // event into hide().
  isQuitting = true
  if (running === null) return
  event.preventDefault()
  // Hard ceiling: if teardown stalls past the watchdog, force-exit so the
  // dev loop isn't blocked. The corestore close runs first inside teardown(),
  // so by this point fd-locks are typically already released.
  const watchdog = setTimeout(() => {
    log.warn("teardown watchdog fired; forcing exit", {
      timeoutMs: TEARDOWN_HARD_TIMEOUT_MS,
    })
    process.exit(0)
  }, TEARDOWN_HARD_TIMEOUT_MS)
  void teardownOnce().finally(() => {
    clearTimeout(watchdog)
    app.quit()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

// electron-vite's dev runner sends SIGTERM on hot-reload; raw signals bypass
// the Electron `before-quit` event entirely. Without a handler the process
// dies before teardown(), leaking corestore fd-locks. SIGINT covers Ctrl-C
// from the dev terminal.
const handleSignal = (signal: NodeJS.Signals): void => {
  log.info("received shutdown signal", { signal })
  const watchdog = setTimeout(() => {
    log.warn("teardown watchdog fired on signal; forcing exit", {
      signal,
      timeoutMs: TEARDOWN_HARD_TIMEOUT_MS,
    })
    process.exit(0)
  }, TEARDOWN_HARD_TIMEOUT_MS)
  void teardownOnce().finally(() => {
    clearTimeout(watchdog)
    process.exit(0)
  })
}
process.on("SIGTERM", handleSignal)
process.on("SIGINT", handleSignal)
