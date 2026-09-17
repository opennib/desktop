import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { BrowserWindow, Menu, Tray, app, nativeImage, screen } from "electron"

import type { PipelineState } from "@opennib/core"

import { IPC_CHANNELS } from "./ipc-channels"

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface CreateWindowOptions {
  /**
   * Read at close-time so the window can decide whether to hide (the common
   * path — renderer must stay alive to keep the audio worklet hot) or actually
   * close (only true after the Tray's Quit item or `before-quit` sets it).
   */
  readonly isQuitting: () => boolean
  /**
   * Read on `ready-to-show` to decide whether to surface the window. Returns
   * false during first-launch onboarding so the main shell stays hidden
   * behind the onboarding window until the user finishes the flow.
   */
  readonly shouldShowOnReady: () => boolean
}

export function createWindow(options: CreateWindowOptions): BrowserWindow {
  // Settings UI + mic capture host. The window IS visible at launch so the
  // user can see the readiness banner, models list, and history. With
  // `app.dock.hide()` set, opennib has no dock entry — so when the user
  // clicks Notes/Slack to type, that app becomes frontmost and the
  // paste-helper Cmd+V lands there. The previously-visible-by-default
  // window was fine; the real problem was the dock entry making opennib
  // re-activatable.
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 820,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    skipTaskbar: true,
    title: "opennib",
    backgroundColor: "#ffffff",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // This hidden window hosts the recorder renderer, whose 50ms
      // setInterval publishes HUD waveform frames. Chromium throttles DOM
      // timers in hidden windows to >=1s, which freezes the waveform while
      // the (unthrottled) audio worklet keeps capturing fine.
      backgroundThrottling: false,
    },
  })

  win.on("ready-to-show", () => {
    if (options.shouldShowOnReady()) win.show()
  })

  // Close button hides instead of destroying — the renderer must stay alive
  // to keep the audio worklet hot for the next Fn-press. Real quit goes
  // through the Tray's Quit item (which sets isQuitting=true).
  win.on("close", (e) => {
    if (!options.isQuitting()) {
      e.preventDefault()
      win.hide()
    }
  })

  const devUrl = process.env["ELECTRON_RENDERER_URL"]
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"))
  }

  return win
}

export function createHudWindow(): BrowserWindow {
  // Floating recording pill. Frameless, transparent, never focusable so
  // the user's target app stays frontmost. Position: bottom-center of the
  // primary display's work area (above the dock).
  const display = screen.getPrimaryDisplay()
  const width = 420
  const height = 80
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2)
  const y = Math.round(display.workArea.y + display.workArea.height - height - 24)

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setAlwaysOnTop(true, "screen-saver")
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Pass clicks through — the HUD must never steal pointer events from
  // whatever app is underneath it.
  win.setIgnoreMouseEvents(true)

  const devUrl = process.env["ELECTRON_RENDERER_URL"]
  if (devUrl) {
    void win.loadURL(`${devUrl}/hud.html`)
  } else {
    void win.loadFile(join(__dirname, "../renderer/hud.html"))
  }

  return win
}

export function setHudState(
  hudWindow: BrowserWindow | undefined,
  state: PipelineState,
): void {
  if (hudWindow === undefined || hudWindow.isDestroyed()) return
  hudWindow.webContents.send(IPC_CHANNELS.state.change, state)
  if (state === "idle") {
    if (hudWindow.isVisible()) hudWindow.hide()
  } else {
    if (!hudWindow.isVisible()) hudWindow.showInactive()
  }
}

export function showMainWindow(mainWindow: BrowserWindow | undefined): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  mainWindow.show()
  mainWindow.focus()
}

export function createOnboardingWindow(): BrowserWindow {
  // First-launch flow lives in its own window, fixed-size and centered. The
  // user clicks through 7 steps (welcome → accessibility → microphone →
  // model → language → try-it-out → done); on completion the main process
  // closes this window and opens the regular shell. Dimensions track the
  // design source at `docs/design-references/.../desktop-onboarding.jsx`.
  const win = new BrowserWindow({
    width: 780,
    height: 580,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    autoHideMenuBar: true,
    skipTaskbar: true,
    title: "Welcome to opennib",
    backgroundColor: "#ffffff",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on("ready-to-show", () => {
    win.show()
    win.focus()
  })

  const devUrl = process.env["ELECTRON_RENDERER_URL"]
  if (devUrl) {
    void win.loadURL(`${devUrl}/onboarding.html`)
  } else {
    void win.loadFile(join(__dirname, "../renderer/onboarding.html"))
  }

  return win
}

export function createTrayWindow(): BrowserWindow {
  // Custom v0.8 popover under the menu-bar icon. Native `Tray.setContextMenu`
  // can't host arbitrary HTML, so the popover is a third frameless transparent
  // BrowserWindow that we position under the tray icon on demand.
  const win = new BrowserWindow({
    width: 320,
    height: 440,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setAlwaysOnTop(true, "pop-up-menu")
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Dismiss on blur — standard macOS popover behavior.
  win.on("blur", () => {
    if (win.isVisible() && !win.webContents.isDevToolsOpened()) win.hide()
  })

  const devUrl = process.env["ELECTRON_RENDERER_URL"]
  if (devUrl) {
    void win.loadURL(`${devUrl}/tray.html`)
  } else {
    void win.loadFile(join(__dirname, "../renderer/tray.html"))
  }

  return win
}

export function positionTrayWindow(win: BrowserWindow, tray: Tray): void {
  const trayBounds = tray.getBounds()
  const winBounds = win.getBounds()
  // Center the popover horizontally under the icon, with a small vertical gap.
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2)
  const y = Math.round(trayBounds.y + trayBounds.height + 4)
  win.setPosition(x, y, false)
}

export interface CreateTrayOptions {
  readonly onTrayClick: () => void
  readonly onQuit: () => void
}

export function createTray(options: CreateTrayOptions): Tray {
  // macOS template images (`*Template.png`) auto-adapt to light/dark menu
  // bars. The icon ships under `resources/` next to the app's native bins.
  const icon = nativeImage.createFromPath(assetPath("tray-iconTemplate.png"))
  const t = new Tray(icon)
  t.setToolTip("opennib — Hold Fn to dictate")
  // Right-click keeps a native fallback for Quit when the custom popover
  // can't render (e.g. devtools-related glitches in dev).
  t.on("right-click", () => {
    t.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: "opennib", enabled: false },
        { type: "separator" },
        { label: "Quit opennib", click: options.onQuit },
      ]),
    )
  })
  t.on("click", options.onTrayClick)
  return t
}

function assetPath(name: string): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(base, "resources", name)
}
